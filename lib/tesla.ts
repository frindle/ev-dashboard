import { readTokens, writeTokens, TeslaTokens } from './config';
import { markTeslaReauthRequired, clearTeslaReauthRequired } from './sessionFlags';
import { loggedFetch } from './apiLog';

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
  chargerPowerKw: number;
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

// route.ts's Promise.all fans out to 4+ Tesla call sites (vehicle_data,
// live_status, one per wall connector) in the same tick. Each used to
// independently call getAccessToken(), and on an expired token each fired
// its own refreshAccessToken() concurrently — Tesla's OAuth server accepts
// the first refresh and 409s the rest (they're using a refresh_token the
// first call just rotated out), and repeated simultaneous hits can trip
// Tesla's own rate limit on the auth endpoint. Single-flight the refresh
// so concurrent callers share one in-flight request instead of racing.
let refreshInFlight: Promise<string | null> | null = null;

async function getAccessToken(): Promise<string | null> {
  const tokens = readTokens();
  if (!tokens) return null;

  const issuedAt = tokens.issued_at ?? 0;
  const expiresIn = tokens.expires_in ?? 28800;
  const expiresAt = issuedAt + expiresIn - 300; // 5-min buffer
  if (Math.floor(Date.now() / 1000) < expiresAt) {
    return tokens.access_token;
  }

  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshAccessToken(tokens).finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function refreshAccessToken(tokens: TeslaTokens): Promise<string | null> {
  const clientId = process.env.TESLA_CLIENT_ID;
  if (!clientId) {
    markTeslaReauthRequired('TESLA_CLIENT_ID env var missing at refresh');
    console.warn('[tesla] refresh skipped: TESLA_CLIENT_ID env var missing');
    return null;
  }

  try {
    const res = await loggedFetch('tesla', 'oauth/refresh', TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: tokens.refresh_token,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const short = body.slice(0, 200).replace(/\s+/g, ' ');
      console.warn(`[tesla] refresh failed: HTTP ${res.status} ${short}`);
      // 400 invalid_grant means the refresh token chain is dead — user re-auth
      // is the only path out. Flag it so the dashboard can surface a banner.
      if (res.status === 400 || res.status === 401) {
        markTeslaReauthRequired(`refresh HTTP ${res.status}: ${short}`);
      }
      return null;
    }
    const fresh = await res.json() as TeslaTokens;
    writeTokens(fresh);
    clearTeslaReauthRequired();
    console.log('[tesla] refresh ok — new token valid for', fresh.expires_in, 's');
    return fresh.access_token;
  } catch (e) {
    console.warn('[tesla] refresh threw:', String(e).slice(0, 200));
    markTeslaReauthRequired('refresh threw: ' + String(e).slice(0, 120));
    return null;
  }
}

// Circuit breaker: repeated failure responses used to just get retried on
// every next poll cycle with no backoff at all (each cycle re-fired live_status
// + vehicle_data + N wall-connector calls, all failing, forever) — this is what
// turned a bad token into 6+ minutes of continuous hammering, and plausibly
// what burned through a month's API billing limit in 2 days. After a run of
// consecutive 401/403/5xx failures, stop calling Fleet API entirely for a
// cooldown window. A 429 is Tesla explicitly saying "back off now" — trip
// immediately on the first one rather than waiting for a run, honoring
// Retry-After if Tesla sends it. 408 ("vehicle asleep") doesn't count toward
// either — it's a normal, expected response, not a failure.
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60_000;
const RATE_LIMIT_COOLDOWN_MS = 15 * 60_000;
let consecutiveFailures = 0;
let circuitOpenUntil = 0;

async function fleetGet<T>(path: string): Promise<T | null> {
  if (Date.now() < circuitOpenUntil) {
    console.log(`[tesla] ${path}: circuit breaker open — skipping until cooldown ends`);
    return null;
  }
  const token = await getAccessToken();
  if (!token) { console.log(`[tesla] ${path}: no access token`); return null; }
  try {
    const res = await loggedFetch('tesla', `GET ${path}`, `${FLEET_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      // Log the status + short body so the user can see why polling isn't
      // returning data. 408 typically means "vehicle is asleep" on
      // /vehicle_data and is normal; 401 means token expired; 403 means
      // missing scope; 429 means rate-limited; 5xx means Tesla side.
      const body = await res.text().catch(() => '');
      console.log(`[tesla] ${path}: HTTP ${res.status} ${body.slice(0, 160).replace(/\s+/g, ' ')}`);
      if (res.status === 401) {
        markTeslaReauthRequired(`401 from ${path}`);
      }
      if (res.status === 429) {
        const retryAfterSec = Number(res.headers.get('retry-after'));
        const cooldownMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : RATE_LIMIT_COOLDOWN_MS;
        circuitOpenUntil = Date.now() + cooldownMs;
        console.warn(`[tesla] 429 rate-limited on ${path} — opening circuit breaker for ${cooldownMs / 1000}s`);
      } else if (res.status === 401 || res.status === 403 || res.status >= 500) {
        consecutiveFailures++;
        if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
          circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
          console.warn(`[tesla] ${consecutiveFailures} consecutive failures — opening circuit breaker for ${CIRCUIT_BREAKER_COOLDOWN_MS / 1000}s`);
        }
      }
      return null;
    }
    consecutiveFailures = 0;
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
    const res = await loggedFetch('tesla', `POST ${path}`, `${FLEET_BASE}${path}`, {
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
    // REST poll has no direct power field (unlike telemetry's ACChargingPower)
    // -- derive it so the field is populated regardless of data source.
    chargerPowerKw: ((cs.charger_actual_current ?? 0) * (cs.charger_voltage ?? 0)) / 1000,
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
// each make a separate API call on the same poll cycle. TTL adapts to whether
// a wall connector was last seen actively drawing power: 30s while charging,
// 5min otherwise -- TOU rates mean charging only really happens midnight-8am,
// so most of the day this cuts live_status calls by ~10x.
const LIVE_STATUS_ACTIVE_MS = 30_000;
// Widened from 5min 2026-07-25 — still hitting the monthly Fleet API quota
// (80% used with days left in the cycle) even after the sustained-charging
// backoff below. This is background home-energy-flow data (solar/grid/
// battery power) when nothing's actively charging — 20min is plenty.
const LIVE_STATUS_IDLE_MS = 20 * 60_000;
// Once a charge session has been steadily active a while, 30s is overkill —
// kW draw doesn't need sub-minute freshness mid-session, only at the start.
// A full overnight TOU charge at 30s the whole time is what pushed the
// Fleet API's monthly quota to 80% usage (email alert, 2026-07-24) — this
// keeps fast detection at the start of a session without paying that cost
// for every hour after. Widened further from 5min same day as the IDLE
// bump above, same reason.
const LIVE_STATUS_SUSTAINED_ACTIVE_MS = 10 * 60_000;
const SUSTAINED_ACTIVE_THRESHOLD_MS = 15 * 60_000;
let liveStatusCache: { siteId: string; data: LiveStatus; at: number; activeSince?: number } | null = null;

function anyConnectorActive(data: LiveStatus): boolean {
  return (data.wall_connectors ?? []).some(wc => wc.wall_connector_state === 1 || (wc.wall_connector_power ?? 0) > 100);
}

// TOU charging kicks in at midnight -- briefly poll at the active cadence
// right at that boundary so charging start is picked up within ~30s instead
// of waiting out a stale idle-window TTL (up to 5min lag otherwise).
function nearMidnightBoundary(): boolean {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  return (h === 23 && m === 59) || (h === 0 && m <= 2);
}

// route.ts calls fetchSiteLiveStatus + fetchWallConnectorVitals(left) +
// fetchWallConnectorVitals(right) all inside one Promise.all. The 5s cache
// above only helps *after* the first call has resolved — three concurrent
// callers all see a stale/empty cache at entry and each fired its own
// live_status fetch, i.e. exactly the "2-4 near-simultaneous calls to the
// same endpoint" pattern in the incident logs. Track the in-flight promise
// so concurrent callers within the same tick share one upstream fetch.
let liveStatusInFlight: { siteId: string; promise: Promise<LiveStatus | null> } | null = null;

async function getLiveStatus(energySiteId: string, telemetryConfirmedCharging = false): Promise<LiveStatus | null> {
  // Serve a fresh-enough cached response without hitting the API at all.
  if (liveStatusCache && liveStatusCache.siteId === energySiteId) {
    const active = anyConnectorActive(liveStatusCache.data);
    // Telemetry already told us (in real time) whether the vehicle is
    // charging — no need to spend 15 minutes of 30s live_status polling to
    // rediscover that ourselves. Skip straight to the relaxed cadence,
    // except right at the midnight TOU boundary, which still gets the fast
    // tier to catch the actual start of a session promptly.
    const sustained = telemetryConfirmedCharging || (active && liveStatusCache.activeSince != null
      && (Date.now() - liveStatusCache.activeSince) > SUSTAINED_ACTIVE_THRESHOLD_MS);
    const ttl = sustained && !nearMidnightBoundary() ? LIVE_STATUS_SUSTAINED_ACTIVE_MS
      : (active || nearMidnightBoundary()) ? LIVE_STATUS_ACTIVE_MS
      : LIVE_STATUS_IDLE_MS;
    if (Date.now() - liveStatusCache.at < ttl) return liveStatusCache.data;
  }
  if (liveStatusInFlight && liveStatusInFlight.siteId === energySiteId) {
    return liveStatusInFlight.promise;
  }

  const promise = (async (): Promise<LiveStatus | null> => {
    const data = await fleetGet<LiveStatus>(`/api/1/energy_sites/${energySiteId}/live_status`);
    if (!data) {
      // Fresh fetch failed (Tesla hiccup, timeout, etc.). Prefer last-known
      // over null so the dashboard doesn't blink to 0 kW. The smart-poll's
      // 30s tick will retry; intermittent failures shouldn't be user-visible.
      return liveStatusCache?.siteId === energySiteId ? liveStatusCache.data : null;
    }
    const nowActive = anyConnectorActive(data);
    const prevActiveSince = liveStatusCache?.siteId === energySiteId ? liveStatusCache.activeSince : undefined;
    const wasActive = liveStatusCache?.siteId === energySiteId ? anyConnectorActive(liveStatusCache.data) : false;
    const activeSince = !nowActive ? undefined : (wasActive && prevActiveSince != null ? prevActiveSince : Date.now());
    liveStatusCache = { siteId: energySiteId, data, at: Date.now(), activeSince };
    return data;
  })();

  liveStatusInFlight = { siteId: energySiteId, promise };
  try {
    return await promise;
  } finally {
    if (liveStatusInFlight?.promise === promise) liveStatusInFlight = null;
  }
}

export async function fetchSiteLiveStatus(energySiteId: string, telemetryConfirmedCharging = false): Promise<TeslaSiteState | null> {
  const data = await getLiveStatus(energySiteId, telemetryConfirmedCharging);
  if (!data) return null;
  return {
    solarPowerW: data.solar_power ?? 0,
    gridPowerW: data.grid_power ?? 0,
    batteryPowerW: data.battery_power ?? 0,
    loadPowerW: data.load_power ?? 0,
    wallChargerPowerW: data.wall_charger_power ?? 0,
  };
}

// Gen 3 Wall Connectors expose an unauthenticated local HTTP API
// (http://<ip>/api/1/vitals) with zero Fleet API quota cost — added
// 2026-07-25 to cut cloud usage after hitting 80% of the monthly quota with
// days left in the billing cycle. Field names are community-documented (no
// official Tesla docs), confirmed stable across the Home Assistant
// tesla_wall_connector integration. Only used when a connector's config has
// localIp set — load-sharing pairs typically expose just one unit's IP on
// the LAN (the other talks to it over a private link), so this is
// necessarily per-side opt-in, not both-or-nothing.
interface LocalVitals {
  contactor_closed?: boolean;
  vehicle_connected?: boolean;
  vehicle_current_a?: number;
  voltageA_v?: number;
  voltageB_v?: number;
  voltageC_v?: number;
  session_energy_wh?: number;
}

async function fetchWallConnectorVitalsLocal(ip: string): Promise<WallConnectorVitals | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`http://${ip}/api/1/vitals`, { signal: controller.signal });
    if (!res.ok) return null;
    const v = await res.json() as LocalVitals;
    const voltageV = v.voltageA_v || v.voltageB_v || v.voltageC_v || 240;
    const currentA = v.vehicle_current_a ?? 0;
    const charging = !!v.contactor_closed;
    return {
      vehicleConnected: !!v.vehicle_connected,
      vehicleCharging: charging,
      currentA,
      voltageV,
      sessionEnergyWh: v.session_energy_wh ?? 0,
      powerW: currentA * voltageV,
      online: true,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Now takes (siteId, serial) since per-connector data comes from live_status
// matched by DIN suffix. Session energy is no longer exposed in this response —
// we report 0 for sessionEnergyWh. Current is derived from power / voltage.
export async function fetchWallConnectorVitals(siteId: string, serial: string, telemetryConfirmedCharging = false, localIp = ''): Promise<WallConnectorVitals | null> {
  if (localIp) {
    const local = await fetchWallConnectorVitalsLocal(localIp);
    if (local) return local;
    // Local fetch failed (device rebooting, network hiccup) — fall through
    // to the cloud path rather than going blank for this poll cycle.
  }
  if (!serial) return null;
  const data = await getLiveStatus(siteId, telemetryConfirmedCharging);
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

// Sticky disable for /components — Tesla removed it from a lot of energy
// sites and it 404s on every dashboard load. Once we see a 404 we skip the
// endpoint for the lifetime of the process. Config-side wall-connector
// data is the source of truth; the API call is enrichment only.
const componentsUnavailableSites = new Set<string>();

export async function fetchWallConnectorList(siteId: string): Promise<Array<{ serial: string; deviceId: string }>> {
  if (componentsUnavailableSites.has(siteId)) return [];
  interface WCComponent { device_id: string; serial_number?: string; din?: string; [k: string]: unknown; }
  interface Components { wall_connectors?: WCComponent[]; [k: string]: unknown; }
  const path = `/api/1/energy_sites/${siteId}/components`;
  const token = await getAccessToken();
  if (!token) return [];
  try {
    const res = await loggedFetch('tesla', `GET ${path}`, `${FLEET_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 404) {
      componentsUnavailableSites.add(siteId);
      console.log(`[wall-connectors] /components 404 for site ${siteId} — disabling for this process`);
      return [];
    }
    if (!res.ok) {
      console.log(`[wall-connectors] ${path}: HTTP ${res.status}`);
      return [];
    }
    const json = await res.json() as { response: Components };
    const data = json.response ?? null;
    return (data?.wall_connectors ?? []).map(w => ({
      deviceId: w.device_id,
      serial: w.serial_number ?? w.din ?? '',
    }));
  } catch (e) {
    console.log(`[wall-connectors] ${path}: fetch error ${String(e).slice(0, 160)}`);
    return [];
  }
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
