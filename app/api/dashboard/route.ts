import { writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { readConfig, readTokens } from '@/lib/config';
import { logError } from '@/lib/logger';
import {
  fetchVehicleState,
  fetchSiteLiveStatus,
  fetchWallConnectorVitals,
  TeslaVehicleState,
  TeslaSiteState,
  WallConnectorVitals,
} from '@/lib/tesla';
import { fetchRivianVehicleState, hasRivianTokens, RivianVehicleState } from '@/lib/rivian';
import { getDoorState, hasMyQTokens } from '@/lib/myq';

export const dynamic = 'force-dynamic';

export interface VehicleData {
  id: 'tesla' | 'rivian';
  name: string;
  model: string;
  chargerSide: 'LEFT' | 'RIGHT';
  state: TeslaVehicleState | RivianVehicleState | null;
  connected: boolean;
  atHome: boolean | null; // true/false when GPS known, null when unknown
}

// Haversine distance in meters
function distanceMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371000;
  const φ1 = aLat * Math.PI / 180;
  const φ2 = bLat * Math.PI / 180;
  const Δφ = (bLat - aLat) * Math.PI / 180;
  const Δλ = (bLon - aLon) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface WallConnectorData {
  side: 'LEFT' | 'RIGHT';
  vehicleName: string;
  vitals: WallConnectorVitals | null;
  sessionKwh: number;  // integrated since most recent idle→active transition
  todayKwh: number;    // integrated since local midnight
}

export interface DashboardData {
  vehicles: VehicleData[];
  wallConnectors: WallConnectorData[];
  site: TeslaSiteState | null;
  weather: WeatherData | null;
  garageConnected: boolean;
  garageDoorOpen: boolean | null;
  streamUrl: string;
  lastUpdated: string;
  teslaConnected: boolean;
  rivianConnected: boolean;
}

export interface WeatherData {
  temp: number;
  feelsLike: number;
  condition: string;
  icon: string;
  humidity: number;
}

async function fetchWeather(cfg: ReturnType<typeof readConfig>): Promise<WeatherData | null> {
  const { apiKey, lat, lon, location } = cfg.weather;
  if (!apiKey) return null;

  try {
    let url: string;
    if (lat !== null && lon !== null) {
      url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=imperial`;
    } else if (location) {
      url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(location)}&appid=${apiKey}&units=imperial`;
    } else {
      return null;
    }

    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[weather] OWM returned ${res.status}: ${body}`);
      void logError('weather', new Error(`OWM ${res.status}: ${body}`));
      return null;
    }

    interface OWMResponse {
      main: { temp: number; feels_like: number; humidity: number };
      weather: Array<{ description: string; icon: string }>;
    }
    const data = await res.json() as OWMResponse;
    return {
      temp: Math.round(data.main.temp),
      feelsLike: Math.round(data.main.feels_like),
      condition: (data.weather[0]?.description ?? '').replace(/^\w/, c => c.toUpperCase()),
      icon: data.weather[0]?.icon ?? '',
      humidity: data.main.humidity,
    };
  } catch (e) {
    console.error('[weather] fetch error:', e);
    void logError('weather', e);
    return null;
  }
}

// Smart-poll: pick how often to actually hit vehicle_data based on the
// last-known state. Burns far less quota than blindly polling every 30s.
//   - Charging or driving (or unknown): 30s
//   - Awake but parked: 5 min (state changes slowly when idle)
//   - Asleep:           5 min (no state can change without a wake)
const TESLA_CACHE_FILE = 'tesla-state.json';
const TESLA_INTERVAL_ACTIVE_MS = 30_000;
const TESLA_INTERVAL_IDLE_MS = 5 * 60_000;
// If telemetry is pushing data, trust it for up to 10 min between updates.
// Tesla only pushes on change, so silence != stale — but if we go too long
// without any update we should still poll once to confirm the vehicle is alive.
const TELEMETRY_TRUST_WINDOW_MS = 10 * 60_000;

interface TeslaCache {
  state: TeslaVehicleState;
  fetchedAt: number;
  source?: 'poll' | 'telemetry';
}

async function smartFetchTesla(vin: string, force: boolean): Promise<TeslaVehicleState | null> {
  const dir = process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
  const path = join(dir, TESLA_CACHE_FILE);

  let cache: TeslaCache | null = null;
  if (existsSync(path)) {
    try { cache = JSON.parse(await readFile(path, 'utf-8')) as TeslaCache; } catch { /* fall through */ }
  }

  if (!force && cache) {
    const ageMs = Date.now() - cache.fetchedAt;
    // Telemetry-sourced data is fresh-by-default; we only poll if it's been
    // silent for the trust window (in case telemetry connection dropped).
    if (cache.source === 'telemetry' && ageMs < TELEMETRY_TRUST_WINDOW_MS) {
      return cache.state;
    }
    // Poll-sourced data: use the original cadence (30s active / 5min idle).
    if (cache.source !== 'telemetry') {
      const isActive = cache.state.isCharging || (cache.state.online && cache.state.chargingState === 'Charging');
      const interval = isActive ? TESLA_INTERVAL_ACTIVE_MS : TESLA_INTERVAL_IDLE_MS;
      if (ageMs < interval) return cache.state;
    }
  }

  const fresh = await fetchVehicleState(vin);
  if (fresh) {
    // Tesla returns a stripped response when the car is asleep — missing
    // fields fall back to defaults in fetchVehicleState (chargeLimit→80,
    // chargePercent→0, lat/lon→null, etc.) which silently overwrite the
    // real last-known values. Preserve cached values for slowly-changing
    // fields whenever the fresh poll reports the car as offline.
    if (cache?.state) {
      if (fresh.lat === null && cache.state.lat !== null) fresh.lat = cache.state.lat;
      if (fresh.lon === null && cache.state.lon !== null) fresh.lon = cache.state.lon;
      if (!fresh.online) {
        // Asleep — Tesla's response is incomplete. Restore last-known good.
        fresh.chargePercent = cache.state.chargePercent;
        fresh.chargeLimit   = cache.state.chargeLimit;
        fresh.rangeMi       = cache.state.rangeMi;
        fresh.odometer      = cache.state.odometer || fresh.odometer;
        fresh.isLocked      = cache.state.isLocked;
        fresh.isPluggedIn   = cache.state.isPluggedIn;
        fresh.chargingState = cache.state.chargingState;
      }
    }
    try {
      await writeFile(path, JSON.stringify({ state: fresh, fetchedAt: Date.now(), source: 'poll' } satisfies TeslaCache));
    } catch { /* non-fatal */ }
    return fresh;
  }
  // Fetch failed — fall back to cached if we have it so the UI doesn't go blank
  return cache?.state ?? null;
}

// ── Wall connector session/today kWh integration ────────────────────────────
// Tesla's new live_status response no longer exposes session_energy_wh. We
// integrate the live power reading ourselves: each poll cycle, multiply
// current power (W) by the elapsed seconds since the previous poll and
// accumulate into per-side session + today buckets. Persisted in keys/
// so the totals survive container restarts.

interface SessionRecord {
  sessionKwh: number;
  todayKwh: number;
  todayDate: string;
  lastInUse: boolean;
  lastUpdate: number;
  sessionStartedAt: number; // ms epoch — 0 when no session in progress
}
interface SessionFile { left: SessionRecord; right: SessionRecord; }
interface ChargeHistoryRow {
  side: 'LEFT' | 'RIGHT';
  vehicleName: string;
  startedAt: string;   // ISO
  endedAt: string;     // ISO
  durationMin: number;
  energyKwh: number;
}

function emptySession(): SessionRecord {
  return { sessionKwh: 0, todayKwh: 0, todayDate: localDateStr(), lastInUse: false, lastUpdate: 0, sessionStartedAt: 0 };
}
function localDateStr(): string {
  return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
}

async function appendChargeHistory(row: ChargeHistoryRow) {
  const historyDir = process.env.CHARGE_HISTORY_DIR ?? process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
  const path = join(historyDir, 'charge-history.jsonl');
  try { await writeFile(path, JSON.stringify(row) + '\n', { flag: 'a' }); }
  catch (e) { console.error('[charge-history] append failed:', e); }
}

async function updateSessionKwh(
  leftPowerW: number, leftInUse: boolean,
  rightPowerW: number, rightInUse: boolean,
  leftVehicleName: string, rightVehicleName: string,
): Promise<{ left: SessionRecord; right: SessionRecord }> {
  const dir = process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
  const path = join(dir, 'charge-sessions.json');

  let file: SessionFile = { left: emptySession(), right: emptySession() };
  if (existsSync(path)) {
    try { file = JSON.parse(await readFile(path, 'utf-8')) as SessionFile; } catch { /* keep defaults */ }
  }

  const now = Date.now();
  const today = localDateStr();
  const endedSessions: Array<{ side: 'LEFT' | 'RIGHT'; row: ChargeHistoryRow }> = [];

  function step(rec: SessionRecord, side: 'LEFT' | 'RIGHT', vehicleName: string, powerW: number, inUse: boolean): SessionRecord {
    // Roll over today bucket at local midnight
    if (rec.todayDate !== today) { rec = { ...rec, todayKwh: 0, todayDate: today }; }
    // Idle → active: start new session
    if (inUse && !rec.lastInUse) { rec = { ...rec, sessionKwh: 0, sessionStartedAt: now }; }
    // Active → idle: log the completed session if it had any energy
    if (!inUse && rec.lastInUse && rec.sessionKwh > 0.01 && rec.sessionStartedAt > 0) {
      endedSessions.push({
        side,
        row: {
          side, vehicleName,
          startedAt: new Date(rec.sessionStartedAt).toISOString(),
          endedAt:   new Date(now).toISOString(),
          durationMin: Math.round((now - rec.sessionStartedAt) / 60_000),
          energyKwh: Math.round(rec.sessionKwh * 100) / 100,
        },
      });
    }
    // Integrate while in use. Skip on first cycle since restart, or if the
    // gap is implausibly large (container was down >10 min).
    if (inUse && rec.lastUpdate > 0 && now - rec.lastUpdate < 10 * 60_000) {
      const elapsedHours = (now - rec.lastUpdate) / 3_600_000;
      const kwh = (powerW / 1000) * elapsedHours;
      rec = { ...rec, sessionKwh: rec.sessionKwh + kwh, todayKwh: rec.todayKwh + kwh };
    }
    return { ...rec, lastInUse: inUse, lastUpdate: now };
  }

  const left  = step(file.left,  'LEFT',  leftVehicleName,  leftPowerW,  leftInUse);
  const right = step(file.right, 'RIGHT', rightVehicleName, rightPowerW, rightInUse);

  try { await writeFile(path, JSON.stringify({ left, right } satisfies SessionFile)); }
  catch { /* non-fatal */ }

  for (const { row } of endedSessions) await appendChargeHistory(row);

  return { left, right };
}

// Persist Rivian's last-known GPS so an offline vehicle keeps its
// home/away status (mirrors the Tesla preservation in smartFetchTesla).
async function fetchRivianWithGpsCache(): Promise<RivianVehicleState | null> {
  const dir = process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
  const path = join(dir, 'rivian-state.json');

  let cachedGps: { lat: number | null; lon: number | null } = { lat: null, lon: null };
  if (existsSync(path)) {
    try {
      const cache = JSON.parse(await readFile(path, 'utf-8')) as { lat: number | null; lon: number | null };
      cachedGps = { lat: cache.lat ?? null, lon: cache.lon ?? null };
    } catch { /* fall through */ }
  }

  const fresh = await fetchRivianVehicleState();
  if (!fresh) return null;

  if (fresh.lat === null && cachedGps.lat !== null) fresh.lat = cachedGps.lat;
  if (fresh.lon === null && cachedGps.lon !== null) fresh.lon = cachedGps.lon;

  if (fresh.lat !== null && fresh.lon !== null) {
    try { await writeFile(path, JSON.stringify({ lat: fresh.lat, lon: fresh.lon })); }
    catch { /* non-fatal */ }
  }
  return fresh;
}

export async function GET(req: Request) {
  try {
    return await handleGet(req);
  } catch (e) {
    console.error('[dashboard] unhandled error:', e);
    void logError('dashboard', e);
    return Response.json({ error: 'internal error', detail: String(e) }, { status: 500 });
  }
}

async function handleGet(req: Request) {
  const cfg = readConfig();
  const teslaConnected = readTokens() !== null;
  const rivianConnected = hasRivianTokens();
  const myqConnected = hasMyQTokens();

  // ?fresh=1 forces a real fetch (used right after a command so the UI reflects it)
  const force = new URL(req.url).searchParams.get('fresh') === '1';

  const leftSerial  = cfg.energySite.wallConnectors.find(w => w.side === 'LEFT')?.serial  ?? '';
  const rightSerial = cfg.energySite.wallConnectors.find(w => w.side === 'RIGHT')?.serial ?? '';

  // Fetch all data in parallel. Site live_status and per-connector vitals now
  // share one underlying API call (Tesla deprecated /wall_connectors/{id}/vitals
  // and moved per-connector fields into the same live_status response).
  const [teslaState, rivianState, siteState, wcLeft, wcRight, weather, doorState] = await Promise.all([
    teslaConnected ? smartFetchTesla(cfg.vehicles.tesla.vin, force) : Promise.resolve(null),
    rivianConnected ? fetchRivianWithGpsCache() : Promise.resolve(null),
    teslaConnected ? fetchSiteLiveStatus(cfg.energySite.id) : Promise.resolve(null),
    teslaConnected && leftSerial  ? fetchWallConnectorVitals(cfg.energySite.id, leftSerial)  : Promise.resolve(null),
    teslaConnected && rightSerial ? fetchWallConnectorVitals(cfg.energySite.id, rightSerial) : Promise.resolve(null),
    fetchWeather(cfg),
    myqConnected && cfg.garage.deviceSerial ? getDoorState(cfg.garage.deviceSerial) : Promise.resolve(null),
  ]);

  function computeAtHome(lat: number | null | undefined, lon: number | null | undefined): boolean | null {
    if (cfg.home.lat === null || cfg.home.lon === null) return null;
    if (lat === null || lat === undefined || lon === null || lon === undefined) return null;
    return distanceMeters(lat, lon, cfg.home.lat, cfg.home.lon) <= cfg.home.radiusMeters;
  }

  const vehicles: VehicleData[] = [
    {
      id: 'rivian',
      name: cfg.vehicles.rivian.name,
      model: cfg.vehicles.rivian.model,
      chargerSide: cfg.vehicles.rivian.chargerSide,
      state: rivianState,
      connected: rivianConnected,
      atHome: computeAtHome(rivianState?.lat, rivianState?.lon),
    },
    {
      id: 'tesla',
      name: cfg.vehicles.tesla.name,
      model: cfg.vehicles.tesla.model,
      chargerSide: cfg.vehicles.tesla.chargerSide,
      state: teslaState,
      connected: teslaConnected,
      atHome: computeAtHome(teslaState?.lat, teslaState?.lon),
    },
  ];

  // Integrate live power into session/today kWh. Appends a row to the history
  // log when a session ends (transition from active → idle).
  const leftVehicleName  = cfg.energySite.wallConnectors.find(w => w.side === 'LEFT')?.vehicleName  ?? 'Rivian';
  const rightVehicleName = cfg.energySite.wallConnectors.find(w => w.side === 'RIGHT')?.vehicleName ?? 'Tesla';
  const sessions = teslaConnected
    ? await updateSessionKwh(
        wcLeft?.powerW ?? 0,  wcLeft?.vehicleCharging ?? false,
        wcRight?.powerW ?? 0, wcRight?.vehicleCharging ?? false,
        leftVehicleName, rightVehicleName,
      )
    : { left: { sessionKwh: 0, todayKwh: 0 }, right: { sessionKwh: 0, todayKwh: 0 } };

  const wallConnectors: WallConnectorData[] = [
    {
      side: 'LEFT',
      vehicleName: leftVehicleName,
      vitals: wcLeft,
      sessionKwh: sessions.left.sessionKwh,
      todayKwh:   sessions.left.todayKwh,
    },
    {
      side: 'RIGHT',
      vehicleName: rightVehicleName,
      vitals: wcRight,
      sessionKwh: sessions.right.sessionKwh,
      todayKwh:   sessions.right.todayKwh,
    },
  ];

  const data: DashboardData = {
    vehicles,
    wallConnectors,
    site: siteState,
    weather,
    garageConnected: myqConnected,
    garageDoorOpen: doorState === 'open' ? true : doorState === 'closed' ? false : null,
    streamUrl: cfg.camera.streamUrl,
    lastUpdated: new Date().toISOString(),
    teslaConnected,
    rivianConnected,
  };

  // Persist to disk so the client can show last-known state on restart
  try {
    const dir = process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
    await writeFile(join(dir, 'last-status.json'), JSON.stringify(data));
  } catch { /* non-fatal */ }

  return Response.json(data);
}
