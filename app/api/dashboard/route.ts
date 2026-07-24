import { writeFile, readFile, unlink } from 'fs/promises';
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
import { readFlags } from '@/lib/sessionFlags';
import { notifyFlagChanges } from '@/lib/notifications';

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

// Fires once per arrival: when a vehicle enters the home radius. For Rivian,
// fires while gearStatus is still "drive" (not waiting for "park" — Rivian's
// smart-poll can lag up to a minute even at the active interval, and waiting
// for "parked" would add the time it takes to actually park+walk in on top
// of that). Tesla's fetched state has no gear/shift-state field, so its call
// just fires on the atHome transition itself (isDriving=true unconditionally)
// — a small simplification, not a functional gap: atHome already requires
// fresh GPS, so this still fires as soon as the vehicle is detected in range.
// A persisted flag prevents re-firing every poll while parked at home;
// resets once the vehicle leaves (atHome false) so the next arrival fires again.
const RIVIAN_ARRIVAL_FLAG_FILE = 'rivian-arrival-notified.json';
const TESLA_ARRIVAL_FLAG_FILE = 'tesla-arrival-notified.json';

async function checkVehicleArrival(webhookUrl: string, flagFile: string, isDriving: boolean, atHome: boolean | null, label: string): Promise<void> {
  if (!webhookUrl) return;

  const dir = process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
  const path = join(dir, flagFile);
  const wasNotified = existsSync(path);

  if (atHome !== true) {
    if (wasNotified) await unlink(path).catch(() => null);
    return;
  }
  if (!isDriving || wasNotified) return;

  try {
    await fetch(webhookUrl, { method: 'POST' });
    await writeFile(path, String(Date.now()));
    console.log(`[${label}] arrival webhook fired`);
  } catch (e) {
    console.error(`[${label}] arrival webhook failed`, e);
  }
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

export interface SolarOpportunity {
  excessSolarW: number;       // solar production beyond current house load (0 when none)
  chargerDrawW: number;       // combined wall-connector draw
  suggestion: string | null;  // human-readable hint when excess is meaningful
}

export interface DashboardFlags {
  teslaReauthRequired: boolean;
  teslaReauthReason: string | null;
  rivianReauthDueSoon: boolean;
  rivianReauthDaysLeft: number | null;
  rivianReauthRequired: boolean;
  rivianReauthReason: string | null;
  rivianOtaUpdateAvailable: boolean;
  rivianOtaInstalling: boolean;
  rivianDerateActive: boolean;
  rivianDerateReason: string | null;
  rivianHvThermalEvent: boolean;
  rivianTirePressureLow: boolean;
  rivianWiperFluidLow: boolean;
  rivianBrakeFluidLow: boolean;
  rivianChargeSlowedLastSession: boolean; // derate was seen at some point during the most recently completed charge
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
  flags: DashboardFlags;
  solarOpportunity: SolarOpportunity | null;
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
// Widened 2026-07-25 from 5min — Fleet API monthly quota hit 80% usage with
// days left in the billing cycle, needed an across-the-board cut, not just
// the live_status tiers. This is now mostly a dead-man's-switch fallback for
// when telemetry isn't covering a field at all, not the primary data path.
const TESLA_INTERVAL_IDLE_MS = 20 * 60_000;
// If telemetry is pushing data, trust it between updates. Tesla only pushes
// on change, so silence != stale — but if we go too long without any update
// we should still poll once to confirm the vehicle is alive. Widened from
// 10min alongside the quota cut above; telemetry silence this long is still
// almost always "nothing changed," not "connection dropped."
const TELEMETRY_TRUST_WINDOW_MS = 30 * 60_000;

interface TeslaCache {
  state: TeslaVehicleState;
  fetchedAt: number;
  source?: 'poll' | 'telemetry';
}

// Log "no home coords configured" exactly once per process. The dashboard
// is polled every few seconds; before this, the user got the same warning
// line for every vehicle on every poll.
let noHomeCoordsWarned = false;
function warnNoHomeOnce(): true {
  if (!noHomeCoordsWarned) {
    console.log('[home] no home coords configured in admin — atHome detection disabled until set');
  }
  return true;
}

// Peek at the telemetry/poll cache's last-known charging state without
// triggering a fetch — telemetry already pushes DetailedChargeState in real
// time, so if it says we're charging, live_status polling doesn't need its
// own slow ramp-up to (re-)discover that fact, only the midnight-boundary
// window still matters for catching the very start of a session.
async function peekTeslaCharging(): Promise<boolean> {
  const dir = process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
  const path = join(dir, TESLA_CACHE_FILE);
  if (!existsSync(path)) return false;
  try {
    const cache = JSON.parse(await readFile(path, 'utf-8')) as TeslaCache;
    return !!cache.state?.isCharging || cache.state?.chargingState === 'Charging';
  } catch {
    return false;
  }
}

async function smartFetchTesla(vin: string, force: boolean): Promise<TeslaVehicleState | null> {
  const dir = process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
  const path = join(dir, TESLA_CACHE_FILE);

  let cache: TeslaCache | null = null;
  if (existsSync(path)) {
    try { cache = JSON.parse(await readFile(path, 'utf-8')) as TeslaCache; } catch { /* fall through */ }
  }

  // Temporary kill switch (TESLA_DISABLE_POLLING=1): never call the Fleet
  // API at all, rely entirely on telemetry -- set while verifying telemetry
  // actually works, after the account got rate-limited/suspended from a
  // polling bug. Overrides ?fresh=1 too, deliberately -- the whole point is
  // zero further API usage while this is on, no exceptions. Unset the env
  // var (and redeploy) to go back to normal smart-poll behavior.
  if (process.env.TESLA_DISABLE_POLLING === '1') {
    return cache?.state ?? null;
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
    // Track whether the lat/lon in the returned object came from this
    // poll vs was restored from the cache. atHome detection should only
    // trust fresh GPS — cached coords get stale the moment the car
    // drives off and Tesla stops reporting (sleep / offline).
    const freshGpsFromPoll = fresh.lat !== null && fresh.lon !== null;
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
    // Only persist when we got a real online response, OR when we
    // already have a cached snapshot and just restored fields onto fresh.
    // The cold-start case (no prior cache + car asleep) returns Tesla's
    // stripped response with chargePercent=0, rangeMi=0, etc. — caching
    // those zeros poisons every subsequent read until the car wakes. We
    // skip the write and let the next poll retry.
    if (fresh.online || cache?.state) {
      try {
        await writeFile(path, JSON.stringify({ state: fresh, fetchedAt: Date.now(), source: 'poll' } satisfies TeslaCache));
      } catch { /* non-fatal */ }
    } else {
      console.log('[tesla] cold-start asleep — not persisting stripped response');
    }
    // Mutate-attach so the caller can tell what happened. (Avoids changing
    // the public return type while still threading the flag through.)
    (fresh as TeslaVehicleState & { _gpsFresh?: boolean })._gpsFresh = freshGpsFromPoll;
    return fresh;
  }
  // Fetch failed — fall back to cached if we have it so the UI doesn't go blank.
  if (cache?.state) (cache.state as TeslaVehicleState & { _gpsFresh?: boolean })._gpsFresh = false;
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
  wasThrottled: boolean;    // true if derate was seen at any point during the CURRENT session
  endedThrottled: boolean;  // sticky: session ended while wasThrottled — cleared on next session start
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
  return { sessionKwh: 0, todayKwh: 0, todayDate: localDateStr(), lastInUse: false, lastUpdate: 0, sessionStartedAt: 0, wasThrottled: false, endedThrottled: false };
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
  leftThrottled: boolean, rightThrottled: boolean,
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

  function step(rec: SessionRecord, side: 'LEFT' | 'RIGHT', vehicleName: string, powerW: number, inUse: boolean, isThrottledNow: boolean): SessionRecord {
    // Roll over today bucket at local midnight
    if (rec.todayDate !== today) { rec = { ...rec, todayKwh: 0, todayDate: today }; }
    // Idle → active: start new session, clearing any "was slowed" alert from
    // the previous one — a fresh session gets a fresh read on throttling.
    if (inUse && !rec.lastInUse) { rec = { ...rec, sessionKwh: 0, sessionStartedAt: now, wasThrottled: false, endedThrottled: false }; }
    // Active → idle: log the completed session if it had any energy, and
    // stick the "was slowed" flag if derate was seen at any point during it
    // — surfaced as a banner so a short-of-goal charge isn't a mystery.
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
      if (rec.wasThrottled) rec = { ...rec, endedThrottled: true };
    }
    // Integrate while in use. Skip on first cycle since restart, or if the
    // gap is implausibly large (container was down >10 min).
    if (inUse && rec.lastUpdate > 0 && now - rec.lastUpdate < 10 * 60_000) {
      const elapsedHours = (now - rec.lastUpdate) / 3_600_000;
      const kwh = (powerW / 1000) * elapsedHours;
      rec = { ...rec, sessionKwh: rec.sessionKwh + kwh, todayKwh: rec.todayKwh + kwh };
    }
    if (inUse && isThrottledNow) rec = { ...rec, wasThrottled: true };
    return { ...rec, lastInUse: inUse, lastUpdate: now };
  }

  const left  = step(file.left,  'LEFT',  leftVehicleName,  leftPowerW,  leftInUse,  leftThrottled);
  const right = step(file.right, 'RIGHT', rightVehicleName, rightPowerW, rightInUse, rightThrottled);

  try { await writeFile(path, JSON.stringify({ left, right } satisfies SessionFile)); }
  catch { /* non-fatal */ }

  for (const { row } of endedSessions) await appendChargeHistory(row);

  return { left, right };
}

// Rivian smart-poll. Same idea as smartFetchTesla: the client hits
// /api/dashboard every 30s, but Rivian's opaque throttling means we should
// not forward every one of those to their GraphQL gateway. Serve the cached
// state between real polls:
//   - Charging: 60s (progress worth showing, still well under the client rate)
//   - Driving: 20s — faster than the client's own 30s poll, so this is
//     effectively a fresh call every client poll during a drive. Deliberate:
//     the garage-light-on-arrival webhook needs to fire close to actual
//     arrival, not minutes late. Bounded to drive duration only, not
//     sustained, so the throttling risk is low despite the rate (Rivian's
//     limits are undocumented — this is a judgment call, not a guarantee).
//   - Otherwise: 5 min (parked/asleep state barely changes)
// The cache also preserves last-known GPS so an offline vehicle keeps its
// home/away status.
const RIVIAN_INTERVAL_CHARGING_MS = 60_000;
const RIVIAN_INTERVAL_DRIVING_MS = 20_000;
const RIVIAN_INTERVAL_IDLE_MS = 5 * 60_000;
// After the vehicle stops driving, keep the fast tier for a bit longer —
// catches a plug-in that happens moments after parking (walking in from the
// garage) instead of waiting for the next 5-min idle cycle to notice.
const RIVIAN_PARKED_GRACE_MS = 180_000;
// Trust GNSS only when it's < 15 min old — older readings (last known
// before sleep) may lie about the current position. Shared by both the
// real-poll and served-from-cache paths so atHome doesn't flicker to
// "unknown" just because a poll cycle skipped the network (see
// fetchRivianWithGpsCache) while the last real GPS fix is still recent.
const GPS_STALE_MS = 15 * 60 * 1000;

interface RivianCache {
  state?: RivianVehicleState;
  fetchedAt?: number;
  parkedAt?: number; // when gearStatus last transitioned away from 'drive'
  // legacy shape (pre full-state cache) — file held bare coords
  lat?: number | null;
  lon?: number | null;
}

async function fetchRivianWithGpsCache(force = false): Promise<RivianVehicleState | null> {
  const dir = process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
  const path = join(dir, 'rivian-state.json');

  let cache: RivianCache = {};
  if (existsSync(path)) {
    try { cache = JSON.parse(await readFile(path, 'utf-8')) as RivianCache; }
    catch { /* fall through */ }
  }
  const cachedGps = {
    lat: cache.state?.lat ?? cache.lat ?? null,
    lon: cache.state?.lon ?? cache.lon ?? null,
  };

  // Fresh-enough cache → don't touch the Rivian API at all this cycle.
  if (!force && cache.state && cache.fetchedAt) {
    const ageMs = Date.now() - cache.fetchedAt;
    // Plugged-in-but-not-yet-charging (e.g. waiting for a TOU window) must
    // use the faster tier too, not idle — otherwise a fresh plug-in event
    // can be masked by a stale "unplugged" cache for up to 5 minutes.
    const justParked = cache.parkedAt != null && (Date.now() - cache.parkedAt) < RIVIAN_PARKED_GRACE_MS;
    const interval = (cache.state.gearStatus === 'drive' || justParked) ? RIVIAN_INTERVAL_DRIVING_MS
      : (cache.state.isCharging || cache.state.isPluggedIn) ? RIVIAN_INTERVAL_CHARGING_MS
      : RIVIAN_INTERVAL_IDLE_MS;
    if (ageMs < interval) {
      // Skipping the network this cycle doesn't mean the GPS data itself is
      // stale — the cached state carries its own gnssTimeStamp from whenever
      // it was actually fetched. Judge freshness by that, the same 15-min
      // threshold a real poll uses, instead of unconditionally going neutral
      // for the whole idle interval (was causing "VEHICLES home" to flicker
      // to 0 every idle cycle even though the vehicle hadn't moved).
      const cachedGnssMs = cache.state.gnssTimeStamp ? new Date(cache.state.gnssTimeStamp).getTime() : 0;
      const cachedGnssFresh = cachedGnssMs > 0 && Date.now() - cachedGnssMs < GPS_STALE_MS;
      (cache.state as RivianVehicleState & { _gpsFresh?: boolean })._gpsFresh = cachedGnssFresh;
      return cache.state;
    }
  }

  const fresh = await fetchRivianVehicleState();
  if (!fresh) {
    // Backoff window or fetch failure — serve last-known so the card
    // doesn't blank out. atHome stays neutral (_gpsFresh=false).
    if (cache.state) {
      (cache.state as RivianVehicleState & { _gpsFresh?: boolean })._gpsFresh = false;
      return cache.state;
    }
    return null;
  }

  // Trust GNSS only when it's < 15 min old and horizontal error is reasonable.
  // Older readings (last known before sleep) may lie about the current position.
  const gnssMs = fresh.gnssTimeStamp ? new Date(fresh.gnssTimeStamp).getTime() : 0;
  const gnssFresh = gnssMs > 0 && Date.now() - gnssMs < GPS_STALE_MS;
  const gnssTrustworthy = gnssFresh && (fresh.gnssErrorM == null || fresh.gnssErrorM < 100);
  const freshGpsFromPoll = fresh.lat !== null && fresh.lon !== null && gnssTrustworthy;

  if ((fresh.lat === null || !gnssTrustworthy) && cachedGps.lat !== null) fresh.lat = cachedGps.lat;
  if ((fresh.lon === null || !gnssTrustworthy) && cachedGps.lon !== null) fresh.lon = cachedGps.lon;

  const justStoppedDriving = cache.state?.gearStatus === 'drive' && fresh.gearStatus !== 'drive';
  const parkedAt = justStoppedDriving ? Date.now()
    : fresh.gearStatus === 'drive' ? undefined
    : cache.parkedAt;
  try {
    await writeFile(path, JSON.stringify({ state: fresh, fetchedAt: Date.now(), parkedAt } satisfies RivianCache));
  } catch { /* non-fatal */ }
  (fresh as RivianVehicleState & { _gpsFresh?: boolean })._gpsFresh = freshGpsFromPoll;
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
  const leftLocalIp  = cfg.energySite.wallConnectors.find(w => w.side === 'LEFT')?.localIp  ?? '';
  const rightLocalIp = cfg.energySite.wallConnectors.find(w => w.side === 'RIGHT')?.localIp ?? '';

  // Fetch all data in parallel. Site live_status and per-connector vitals now
  // share one underlying API call (Tesla deprecated /wall_connectors/{id}/vitals
  // and moved per-connector fields into the same live_status response).
  const telemetryConfirmedCharging = teslaConnected ? await peekTeslaCharging() : false;

  const [teslaState, rivianState, siteState, wcLeft, wcRight, weather, doorState] = await Promise.all([
    teslaConnected ? smartFetchTesla(cfg.vehicles.tesla.vin, force) : Promise.resolve(null),
    rivianConnected ? fetchRivianWithGpsCache(force) : Promise.resolve(null),
    teslaConnected ? fetchSiteLiveStatus(cfg.energySite.id, telemetryConfirmedCharging) : Promise.resolve(null),
    leftLocalIp || (teslaConnected && leftSerial)  ? fetchWallConnectorVitals(cfg.energySite.id, leftSerial, telemetryConfirmedCharging, leftLocalIp)  : Promise.resolve(null),
    rightLocalIp || (teslaConnected && rightSerial) ? fetchWallConnectorVitals(cfg.energySite.id, rightSerial, telemetryConfirmedCharging, rightLocalIp) : Promise.resolve(null),
    fetchWeather(cfg),
    myqConnected && cfg.garage.deviceSerial ? getDoorState(cfg.garage.deviceSerial) : Promise.resolve(null),
  ]);

  // Resolve "home" coordinates. If the admin hasn't filled out the home
  // section, fall back to the weather location — for most setups that's
  // literally where the user lives (your "weather" lat/lon is your house's
  // postcode), and requiring two separate inputs for the same physical
  // location just leaves home-detection silently broken.
  const homeLat = cfg.home.lat ?? cfg.weather.lat ?? null;
  const homeLon = cfg.home.lon ?? cfg.weather.lon ?? null;
  const homeRadius = cfg.home.radiusMeters > 0 ? cfg.home.radiusMeters : 150;

  function computeAtHome(label: string, lat: number | null | undefined, lon: number | null | undefined, gpsFresh: boolean): boolean | null {
    if (homeLat === null || homeLon === null) {
      noHomeCoordsWarned ||= warnNoHomeOnce();
      return null;
    }
    if (lat === null || lat === undefined || lon === null || lon === undefined) {
      return null;
    }
    if (!gpsFresh) {
      // Lat/lon came from cache, not this poll. We can't tell if the car
      // is still here or drove off — return null instead of falsely
      // reporting at-home. (UI keeps showing cached coords for "last
      // seen at" purposes, but the at-home dot stays neutral.)
      console.log(`[home] ${label}: GPS stale (from cache) — atHome=null until vehicle reports fresh location`);
      return null;
    }
    const dist = distanceMeters(lat, lon, homeLat, homeLon);
    const atHome = dist <= homeRadius;
    console.log(`[home] ${label}: lat=${lat.toFixed(5)},lon=${lon.toFixed(5)} home=${homeLat.toFixed(5)},${homeLon.toFixed(5)} dist=${dist.toFixed(0)}m radius=${homeRadius}m → atHome=${atHome}`);
    return atHome;
  }

  const rivianAtHome = computeAtHome('rivian', rivianState?.lat, rivianState?.lon, !!(rivianState && (rivianState as { _gpsFresh?: boolean })._gpsFresh));
  if (rivianState) await checkVehicleArrival(cfg.home.arrivalWebhookUrl, RIVIAN_ARRIVAL_FLAG_FILE, rivianState.gearStatus === 'drive', rivianAtHome, 'rivian');

  const teslaAtHome = computeAtHome('tesla', teslaState?.lat, teslaState?.lon, !!(teslaState && (teslaState as { _gpsFresh?: boolean })._gpsFresh));
  if (teslaState) await checkVehicleArrival(cfg.home.arrivalWebhookUrl, TESLA_ARRIVAL_FLAG_FILE, true, teslaAtHome, 'tesla');

  const vehicles: VehicleData[] = [
    {
      id: 'rivian',
      name: cfg.vehicles.rivian.name,
      model: cfg.vehicles.rivian.model,
      chargerSide: cfg.vehicles.rivian.chargerSide,
      state: rivianState,
      connected: rivianConnected,
      atHome: rivianAtHome,
    },
    {
      id: 'tesla',
      name: cfg.vehicles.tesla.name,
      model: cfg.vehicles.tesla.model,
      chargerSide: cfg.vehicles.tesla.chargerSide,
      state: teslaState,
      connected: teslaConnected,
      atHome: teslaAtHome,
    },
  ];

  // Integrate live power into session/today kWh. Appends a row to the history
  // log when a session ends (transition from active → idle).
  const leftVehicleName  = cfg.energySite.wallConnectors.find(w => w.side === 'LEFT')?.vehicleName  ?? 'Rivian';
  const rightVehicleName = cfg.energySite.wallConnectors.find(w => w.side === 'RIGHT')?.vehicleName ?? 'Tesla';
  // Only Rivian ever reports isThrottled today (Tesla's API doesn't expose
  // it — always false there), matched to whichever side it's actually
  // wired to rather than assumed.
  const leftThrottled  = cfg.vehicles.rivian.chargerSide === 'LEFT'  ? !!rivianState?.isThrottled : !!teslaState?.isThrottled;
  const rightThrottled = cfg.vehicles.rivian.chargerSide === 'RIGHT' ? !!rivianState?.isThrottled : !!teslaState?.isThrottled;
  const sessions = teslaConnected
    ? await updateSessionKwh(
        wcLeft?.powerW ?? 0,  wcLeft?.vehicleCharging ?? false,
        wcRight?.powerW ?? 0, wcRight?.vehicleCharging ?? false,
        leftVehicleName, rightVehicleName,
        leftThrottled, rightThrottled,
      )
    : { left: { sessionKwh: 0, todayKwh: 0, endedThrottled: false }, right: { sessionKwh: 0, todayKwh: 0, endedThrottled: false } };

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

  const flagsPersisted = readFlags();
  const rivState = rivianState as RivianVehicleState | null;
  const tirePressureLow = !!rivState && [
    rivState.tirePressureFL, rivState.tirePressureFR,
    rivState.tirePressureRL, rivState.tirePressureRR,
  ].some(v => v && /low|critical/i.test(v));

  const flags: DashboardFlags = {
    teslaReauthRequired: !!flagsPersisted.tesla_reauth_required,
    teslaReauthReason: flagsPersisted.tesla_reauth_required?.reason ?? null,
    rivianReauthDueSoon: !!flagsPersisted.rivian_reauth_due_soon,
    rivianReauthDaysLeft: flagsPersisted.rivian_reauth_due_soon?.daysLeft ?? null,
    rivianReauthRequired: !!flagsPersisted.rivian_reauth_required,
    rivianReauthReason: flagsPersisted.rivian_reauth_required?.reason ?? null,
    rivianOtaUpdateAvailable: !!rivState?.otaUpdateAvailable,
    rivianOtaInstalling: !!rivState?.otaInstalling,
    rivianDerateActive: !!rivState?.isThrottled,
    rivianDerateReason: rivState?.isThrottled ? rivState.derateReason : null,
    rivianHvThermalEvent: !!rivState?.hvThermalActive,
    rivianTirePressureLow: tirePressureLow,
    rivianWiperFluidLow: !!rivState && /low/i.test(rivState.wiperFluidState),
    rivianBrakeFluidLow: !!rivState?.brakeFluidLow,
    rivianChargeSlowedLastSession: cfg.vehicles.rivian.chargerSide === 'LEFT' ? sessions.left.endedThrottled : sessions.right.endedThrottled,
  };

  // Fire-and-forget Pushover notifications for newly raised flags
  // (deduped per lapse / per OTA version inside the notifier).
  try {
    notifyFlagChanges({
      teslaReauthRequired: flags.teslaReauthRequired,
      teslaReauthReason: flags.teslaReauthReason,
      rivianReauthRequired: flags.rivianReauthRequired,
      rivianReauthReason: flags.rivianReauthReason,
      rivianReauthDueSoon: flags.rivianReauthDueSoon,
      rivianReauthDaysLeft: flags.rivianReauthDaysLeft,
      rivianOtaUpdateAvailable: flags.rivianOtaUpdateAvailable,
      rivianOtaAvailableVersion: rivState?.otaAvailableVersion ?? '',
    });
  } catch (e) {
    console.warn('[notify] failed:', String(e).slice(0, 160));
  }

  // Excess-solar opportunity: production beyond what the house is drawing
  // right now. Charger draw is added back to "load" headroom because that
  // power is elective — the point is "how much could go into a car for
  // free". Data only; the dashboard renders it once design ships.
  let solarOpportunity: SolarOpportunity | null = null;
  if (siteState) {
    const chargerDrawW = (wcLeft?.powerW ?? 0) + (wcRight?.powerW ?? 0);
    const houseLoadW = Math.max(0, siteState.loadPowerW - chargerDrawW);
    const excessSolarW = Math.max(0, Math.round(siteState.solarPowerW - houseLoadW));
    const kw = excessSolarW / 1000;
    solarOpportunity = {
      excessSolarW,
      chargerDrawW: Math.round(chargerDrawW),
      // 1.5 kW ≈ the minimum meaningful AC charge rate; below that the hint is noise.
      suggestion: excessSolarW >= 1500 && chargerDrawW < 100
        ? `~${kw.toFixed(1)} kW of excess solar available — a good time to charge`
        : null,
    };
    if (solarOpportunity.suggestion) {
      console.log(`[solar] ${solarOpportunity.suggestion} (solar=${siteState.solarPowerW}W house=${houseLoadW}W chargers=${chargerDrawW}W)`);
    }
  }

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
    flags,
    solarOpportunity,
  };

  // Persist to disk so the client can show last-known state on restart
  try {
    const dir = process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
    await writeFile(join(dir, 'last-status.json'), JSON.stringify(data));
  } catch { /* non-fatal */ }

  return Response.json(data);
}
