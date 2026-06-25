import { readTokens, writeTokens, TeslaTokens } from './config';

const FLEET_BASE = 'https://fleet-api.prd.na.vn.cloud.tesla.com';
const TOKEN_URL = 'https://auth.tesla.com/oauth2/v3/token';

export interface TeslaVehicleState {
  chargePercent: number;
  chargeLimit: number;
  isCharging: boolean;
  isPluggedIn: boolean;
  isThrottled: boolean;       // Tesla doesn't expose this; always false
  derateReason: string;       // Tesla doesn't expose this; always ''
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
  if (!token) { console.log(`[tesla] ${path}: no access token`); return null; }
  try {
    const res = await fetch(`${FLEET_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      // Log the status + short body so the user can see why polling isn't
      // returning data. 408 typically means "vehicle is asleep" on
      // /vehicle_data and is normal; 401 means token expired; 403 means
      // missing scope; 5xx means Tesla side.
      const body = await res.text().catch(() => '');
      console.log(`[tesla] ${path}: HTTP ${res.status} ${body.slice(0, 160).replace(/\s+/g, ' ')}`);
      return null;
    }
    const json = await res.json() as { response: T };
    return json.response ?? null;
  } catch (e) {
    console.log(`[tesla] ${path}: fetch error ${String(e).slice(0, 160)}`);
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

  // `location_data` (and drive_state's latitude/longitude) require the
  // vehicle_location scope. Tesla currently refuses to grant that scope
  // on our developer app despite the portal showing it checked, so
  // requesting it 403s the entire call. Drop location_data so the rest
  // of vehicle_data (charge / vehicle / climate state) comes through.
  // Tesla at-home detection has to come via Fleet Telemetry once the
  // scope ticket clears and BLE pairing is done at the car.
  const data = await fleetGet<VehicleData>(`/api/1/vehicles/${vin}/vehicle_data?endpoints=charge_state%3Bvehicle_state%3Bclimate_state`);
  if (!data) return null;

  const cs = data.charge_state ?? {};
  const vs = data.vehicle_state ?? {};
  const cls = data.climate_state ?? {};
  const ds = data.drive_state ?? {};

  return {
    chargePercent: cs.battery_level ?? 0,
    chargeLimit: cs.charge_limit_soc ?? 80,
    isCharging: cs.charging_state === 'Charging',
    // Any non-Disconnected state means the cable is in the port. Tesla's
    // values: Disconnected | Connected | Charging | Complete | Stopped | NoPower
    isPluggedIn: cs.charging_state !== undefined && cs.charging_state !== 'Disconnected',
    isThrottled: false,
    derateReason: '',
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

// As of mid-2026 Tesla deprecated /api/1/wall_connectors/{id}/vitals (returns
// 404). Per-connector data now lives inside the energy site live_status response
// under wall_connectors[], keyed by DIN like "1457768-02-H--<serial>".
interface LiveStatusWC {
  din: string;
  wall_connector_state?: number;   // 1=in use, 2=idle, observed
  wall_connector_fault_state?: number;
  wall_connector_power?: number;   // watts
  ocpp_status?: number;
  powershare_session_state?: number;
}
interface LiveStatus {
  solar_power?: number;
  grid_power?: number;
  battery_power?: number;
  load_power?: number;
  wall_charger_power?: number;
  wall_connectors?: LiveStatusWC[];
}

// Module-level cache so fetchSiteLiveStatus and fetchWallConnectorVitals don't
// each make a separate API call on the same poll cycle. Cached for 5 seconds.
let liveStatusCache: { siteId: string; data: LiveStatus; at: number } | null = null;

async function getLiveStatus(energySiteId: string): Promise<LiveStatus | null> {
  // Serve a fresh-enough cached response without hitting the API at all.
  if (liveStatusCache && liveStatusCache.siteId === energySiteId && Date.now() - liveStatusCache.at < 5000) {
    return liveStatusCache.data;
  }
  const data = await fleetGet<LiveStatus>(`/api/1/energy_sites/${energySiteId}/live_status`);
  if (!data) {
    // Fresh fetch failed (Tesla hiccup, timeout, etc.). Prefer last-known
    // over null so the dashboard doesn't blink to 0 kW. The smart-poll's
    // 30s tick will retry; intermittent failures shouldn't be user-visible.
    return liveStatusCache?.siteId === energySiteId ? liveStatusCache.data : null;
  }
  liveStatusCache = { siteId: energySiteId, data, at: Date.now() };
  return data;
}

export async function fetchSiteLiveStatus(energySiteId: string): Promise<TeslaSiteState | null> {
  const data = await getLiveStatus(energySiteId);
  if (!data) return null;
  return {
    solarPowerW: data.solar_power ?? 0,
    gridPowerW: data.grid_power ?? 0,
    batteryPowerW: data.battery_power ?? 0,
    loadPowerW: data.load_power ?? 0,
    wallChargerPowerW: data.wall_charger_power ?? 0,
  };
}

// Now takes (siteId, serial) since per-connector data comes from live_status
// matched by DIN suffix. Session energy is no longer exposed in this response —
// we report 0 for sessionEnergyWh. Current is derived from power / voltage.
export async function fetchWallConnectorVitals(siteId: string, serial: string): Promise<WallConnectorVitals | null> {
  if (!serial) return null;
  const data = await getLiveStatus(siteId);
  const wc = data?.wall_connectors?.find(w => w.din?.endsWith(`--${serial}`));
  if (!wc) return null;

  const powerW = wc.wall_connector_power ?? 0;
  const voltageV = 240; // US split-phase assumption
  const currentA = powerW > 0 ? powerW / voltageV : 0;
  // state: 1 = in use / charging, 2 = idle. Treat any positive draw as charging.
  const inUse = (wc.wall_connector_state === 1) || powerW > 100;
  return {
    vehicleConnected: inUse,
    vehicleCharging: inUse,
    currentA,
    voltageV,
    sessionEnergyWh: 0,
    powerW,
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
