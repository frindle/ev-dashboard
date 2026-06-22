import { readTokens, writeTokens, TeslaTokens } from './config';

const FLEET_BASE = 'https://fleet-api.prd.na.vn.cloud.tesla.com';
const TOKEN_URL = 'https://auth.tesla.com/oauth2/v3/token';

export interface TeslaVehicleState {
  chargePercent: number;
  chargeLimit: number;
  isCharging: boolean;
  chargingState: string;
  isLocked: boolean;
  climateOn: boolean;
  rangeMi: number;
  odometer: number;
  chargeRateMph: number;
  addedRangeMi: number;
  minutesToFull: number;
  chargerActualCurrentA: number;
  chargerVoltage: number;
  online: boolean;
  lat: number | null;
  lon: number | null;
}

export interface TeslaSiteState {
  solarPowerW: number;
  gridPowerW: number;
  batteryPowerW: number;
  loadPowerW: number;
  wallChargerPowerW: number;
}

export interface WallConnectorVitals {
  vehicleConnected: boolean;
  vehicleCharging: boolean;
  currentA: number;
  voltageV: number;
  sessionEnergyWh: number;
  powerW: number;
  online: boolean;
}

async function getAccessToken(): Promise<string | null> {
  const tokens = readTokens();
  if (!tokens) return null;

  const issuedAt = tokens.issued_at ?? 0;
  const expiresIn = tokens.expires_in ?? 28800;
  const expiresAt = issuedAt + expiresIn - 300; // 5-min buffer
  if (Math.floor(Date.now() / 1000) < expiresAt) {
    return tokens.access_token;
  }

  // Refresh
  return refreshAccessToken(tokens);
}

async function refreshAccessToken(tokens: TeslaTokens): Promise<string | null> {
  const clientId = process.env.TESLA_CLIENT_ID;
  if (!clientId) return null;

  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: tokens.refresh_token,
      }),
    });
    if (!res.ok) return null;
    const fresh = await res.json() as TeslaTokens;
    writeTokens(fresh);
    return fresh.access_token;
  } catch {
    return null;
  }
}

async function fleetGet<T>(path: string): Promise<T | null> {
  const token = await getAccessToken();
  if (!token) return null;
  try {
    const res = await fetch(`${FLEET_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const json = await res.json() as { response: T };
    return json.response ?? null;
  } catch {
    return null;
  }
}

async function fleetPost<T>(path: string, body: unknown): Promise<T | null> {
  const token = await getAccessToken();
  if (!token) return null;
  try {
    const res = await fetch(`${FLEET_BASE}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const json = await res.json() as { response: T };
    return json.response ?? null;
  } catch {
    return null;
  }
}

export async function fetchVehicleState(vin: string): Promise<TeslaVehicleState | null> {
  interface VehicleData {
    state?: string;
    charge_state?: {
      battery_level?: number;
      charge_limit_soc?: number;
      charging_state?: string;
      charge_rate?: number;
      battery_range?: number;
      charge_miles_added_rated?: number;
      minutes_to_full_charge?: number;
      charger_actual_current?: number;
      charger_voltage?: number;
    };
    vehicle_state?: { locked?: boolean; odometer?: number };
    climate_state?: { is_climate_on?: boolean };
    drive_state?: { latitude?: number; longitude?: number };
  }

  const data = await fleetGet<VehicleData>(`/api/1/vehicles/${vin}/vehicle_data?endpoints=charge_state%3Bvehicle_state%3Bclimate_state%3Bdrive_state%3Blocation_data`);
  if (!data) return null;

  const cs = data.charge_state ?? {};
  const vs = data.vehicle_state ?? {};
  const cls = data.climate_state ?? {};
  const ds = data.drive_state ?? {};

  return {
    chargePercent: cs.battery_level ?? 0,
    chargeLimit: cs.charge_limit_soc ?? 80,
    isCharging: cs.charging_state === 'Charging',
    chargingState: cs.charging_state ?? 'Unknown',
    isLocked: vs.locked ?? true,
    climateOn: cls.is_climate_on ?? false,
    rangeMi: cs.battery_range ?? 0,
    odometer: vs.odometer ?? 0,
    chargeRateMph: cs.charge_rate ?? 0,
    addedRangeMi: cs.charge_miles_added_rated ?? 0,
    minutesToFull: cs.minutes_to_full_charge ?? 0,
    chargerActualCurrentA: cs.charger_actual_current ?? 0,
    chargerVoltage: cs.charger_voltage ?? 0,
    online: data.state === 'online',
    lat: ds.latitude ?? null,
    lon: ds.longitude ?? null,
  };
}

export async function fetchSiteLiveStatus(energySiteId: string): Promise<TeslaSiteState | null> {
  interface LiveStatus {
    solar_power?: number;
    grid_power?: number;
    battery_power?: number;
    load_power?: number;
    wall_charger_power?: number;
  }
  const data = await fleetGet<LiveStatus>(`/api/1/energy_sites/${energySiteId}/live_status`);
  if (!data) return null;
  return {
    solarPowerW: data.solar_power ?? 0,
    gridPowerW: data.grid_power ?? 0,
    batteryPowerW: data.battery_power ?? 0,
    loadPowerW: data.load_power ?? 0,
    wallChargerPowerW: data.wall_charger_power ?? 0,
  };
}

export async function fetchWallConnectorVitals(deviceId: string): Promise<WallConnectorVitals | null> {
  interface Vitals {
    vehicle_connected?: boolean;
    contactor_closed?: boolean;
    current_a_a?: number;
    current_b_a?: number;
    input_voltage_v?: number;
    session_energy_wh?: number;
  }
  const data = await fleetGet<Vitals>(`/api/1/wall_connectors/${deviceId}/vitals`);
  if (!data) return null;

  const currentA = (data.current_a_a ?? 0) + (data.current_b_a ?? 0);
  const voltageV = data.input_voltage_v ?? 240;
  return {
    vehicleConnected: data.vehicle_connected ?? false,
    vehicleCharging: data.contactor_closed ?? false,
    currentA,
    voltageV,
    sessionEnergyWh: data.session_energy_wh ?? 0,
    powerW: currentA * voltageV,
    online: true,
  };
}

export async function fetchWallConnectorList(siteId: string): Promise<Array<{ serial: string; deviceId: string }>> {
  interface WCComponent { device_id: string; serial_number?: string; din?: string; [k: string]: unknown; }
  interface Components { wall_connectors?: WCComponent[]; [k: string]: unknown; }
  const data = await fleetGet<Components>(`/api/1/energy_sites/${siteId}/components`);
  console.log('[wall-connectors] raw components keys:', data ? Object.keys(data) : null);
  console.log('[wall-connectors] raw wall_connectors:', JSON.stringify(data?.wall_connectors));
  return (data?.wall_connectors ?? []).map(w => ({
    deviceId: w.device_id,
    serial: w.serial_number ?? w.din ?? '',
  }));
}


export async function wakeVehicle(vin: string): Promise<boolean> {
  const res = await fleetPost<{ result?: boolean }>(`/api/1/vehicles/${vin}/wake_up`, {});
  return !!res;
}

export async function setChargeLimit(vin: string, percent: number): Promise<boolean> {
  const res = await fleetPost<{ result?: boolean }>(`/api/1/vehicles/${vin}/command/set_charge_limit`, { percent });
  return (res as { result?: boolean } | null)?.result ?? false;
}

export async function startCharging(vin: string): Promise<boolean> {
  const res = await fleetPost<{ result?: boolean }>(`/api/1/vehicles/${vin}/command/charge_start`, {});
  return (res as { result?: boolean } | null)?.result ?? false;
}

export async function stopCharging(vin: string): Promise<boolean> {
  const res = await fleetPost<{ result?: boolean }>(`/api/1/vehicles/${vin}/command/charge_stop`, {});
  return (res as { result?: boolean } | null)?.result ?? false;
}

export async function lockDoors(vin: string): Promise<boolean> {
  const res = await fleetPost<{ result?: boolean }>(`/api/1/vehicles/${vin}/command/door_lock`, {});
  return (res as { result?: boolean } | null)?.result ?? false;
}

export async function unlockDoors(vin: string): Promise<boolean> {
  const res = await fleetPost<{ result?: boolean }>(`/api/1/vehicles/${vin}/command/door_unlock`, {});
  return (res as { result?: boolean } | null)?.result ?? false;
}

export async function startClimate(vin: string): Promise<boolean> {
  const res = await fleetPost<{ result?: boolean }>(`/api/1/vehicles/${vin}/command/auto_conditioning_start`, {});
  return (res as { result?: boolean } | null)?.result ?? false;
}

export async function stopClimate(vin: string): Promise<boolean> {
  const res = await fleetPost<{ result?: boolean }>(`/api/1/vehicles/${vin}/command/auto_conditioning_stop`, {});
  return (res as { result?: boolean } | null)?.result ?? false;
}

export function hasTokens(): boolean {
  return readTokens() !== null;
}
