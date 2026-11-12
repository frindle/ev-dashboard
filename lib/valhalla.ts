// Route miles and seconds from the self-hosted Valhalla (VALHALLA_URL, LAN,
// Nevada only) or, for a leg with an end outside Nevada or one the LAN copy
// cannot route, the FOSSGIS Valhalla (lib/onlineGeo.ts: end points rounded to
// about 1 km, off with GEO_ONLINE=0); and the traffic rule for a leg's time
// (EV charge plan #8).
//
// Routes are cached in keys/route-cache.json by a hash of the rounded
// coordinates (HMAC with the drive-cell salt when given); raw coordinates are
// never written to the cache, a log line or an error message.
//
// Traffic, in order:
//   1. your own times: >= 3 logged drives between the same start/end salted
//      cells (lib/driveCell.ts) in the same local hour band -> their median;
//   2. Valhalla's time x the hour-of-week factor from keys/traffic-profiles.json
//      ({ "hourOfWeek": [168 numbers] }, index = day of week (Sun = 0) * 24 +
//      local hour; the TomTom corridor job that fills it is out of scope);
//   3. Valhalla's time + max(15 min, 20%).
import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hashCell } from './driveCell.ts';
import type { LatLon } from './ics.ts';
import { inNevada, ONLINE_UA, onlineGeo, round2, spaced } from './onlineGeo.ts';

export interface Leg { miles: number; seconds: number }

export const MIN_OWN_DRIVES = 3;
export const SLACK_MIN_SECONDS = 15 * 60;
export const SLACK_FRACTION = 0.2;

const r4 = (x: number) => (Math.round(x * 1e4) / 1e4).toFixed(4);

export function routeKey(a: LatLon, b: LatLon, salt?: Buffer | string): string {
  const text = `${r4(a.lat)},${r4(a.lon)}>${r4(b.lat)},${r4(b.lon)}`;
  return (salt ? createHmac('sha256', salt).update(text) : createHash('sha256').update(text)).digest('hex').slice(0, 32);
}

export interface RouteCache {
  get(key: string): Leg | undefined;
  set(key: string, leg: Leg): void | Promise<void>;
}

export function memoryRouteCache(): RouteCache {
  const m = new Map<string, Leg>();
  return { get: (k) => m.get(k), set: (k, v) => { m.set(k, v); } };
}

// keys/route-cache.json: { "<hash>": { miles, seconds } }, written atomically.
export function fileRouteCache(path = join(process.env.KEYS_DIR ?? join(process.cwd(), 'keys'), 'route-cache.json')): RouteCache & { load(): Promise<void> } {
  let data: Record<string, Leg> = {};
  let loaded = false;
  return {
    async load() {
      if (loaded) return;
      loaded = true;
      try { data = JSON.parse(await readFile(path, 'utf-8')) as Record<string, Leg>; } catch { data = {}; }
    },
    get: (k) => data[k],
    async set(k, v) {
      data[k] = v;
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path + '.tmp', JSON.stringify(data));
        await rename(path + '.tmp', path);
      } catch (e) { console.error('[trips] route cache write failed:', (e instanceof Error ? e.name : 'error')); }
    },
  };
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

async function valhalla(base: string, a: LatLon, b: LatLon, online: boolean, f: FetchLike): Promise<Leg | null> {
  const pt = (p: LatLon) => (online ? { lat: round2(p.lat), lon: round2(p.lon) } : { lat: p.lat, lon: p.lon });
  const url = `${base.replace(/\/+$/, '')}/route`;
  try {
    const call = () => f(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(online ? { 'User-Agent': ONLINE_UA } : {}) },
      body: JSON.stringify({ locations: [pt(a), pt(b)], costing: 'auto', units: 'miles' }),
      signal: AbortSignal.timeout(15_000),
    });
    const res = online ? await spaced(url, call) : await call();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const s = ((await res.json()) as { trip?: { summary?: { length?: number; time?: number } } }).trip?.summary;
    if (!s || !Number.isFinite(s.length) || !Number.isFinite(s.time)) throw new Error('no route');
    return { miles: s.length as number, seconds: s.time as number };
  } catch (e) {
    console.error(`[trips] ${online ? 'online ' : ''}route failed:`, (e instanceof Error ? e.name : 'error'));
    return null;
  }
}

// Driving miles and seconds from a to b with no traffic. Both ends in Nevada:
// the LAN Valhalla, then the online one if that fails. An end outside Nevada:
// the online one first (the LAN tiles would snap it to a Nevada road), then
// the LAN one. null when neither is set, reachable or finds a route.
export async function routeLeg(
  a: LatLon, b: LatLon,
  deps: { env?: Record<string, string | undefined>; fetchImpl?: FetchLike; cache: RouteCache; salt?: Buffer | string },
): Promise<Leg | null> {
  const env = deps.env ?? process.env;
  const local = env.VALHALLA_URL || null;
  const online = onlineGeo(env).valhalla;
  if (!local && !online) return null;
  const key = routeKey(a, b, deps.salt);
  const hit = deps.cache.get(key);
  if (hit) return hit;
  const f = deps.fetchImpl ?? (fetch as unknown as FetchLike);
  const order: [string | null, boolean][] = inNevada(a) && inNevada(b) ? [[local, false], [online, true]] : [[online, true], [local, false]];
  for (const [base, isOnline] of order) {
    if (!base) continue;
    const leg = await valhalla(base, a, b, isOnline, f);
    if (leg) { await deps.cache.set(key, leg); return leg; }
  }
  return null;
}

export interface OwnDrive { start: string; end: string; start_cell?: string | null; end_cell?: string | null }

export function cellOf(salt: Buffer | string, p: LatLon): string { return hashCell(salt, p.lat, p.lon); }

export type TrafficTier = 1 | 2 | 3;

export function legTraffic(p: {
  baseSeconds: number; departMs: number; fromCell: string; toCell: string;
  drives: OwnDrive[]; hourOfWeek: number[] | null;
}): { seconds: number; tier: TrafficTier } {
  const d = new Date(p.departMs);
  const hour = d.getHours();
  const own: number[] = [];
  for (const x of p.drives) {
    if (x.start_cell !== p.fromCell || x.end_cell !== p.toCell) continue;
    const s = Date.parse(x.start), e = Date.parse(x.end);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s || new Date(s).getHours() !== hour) continue;
    own.push((e - s) / 1000);
  }
  if (own.length >= MIN_OWN_DRIVES) {
    own.sort((a, b) => a - b);
    const m = own.length >> 1;
    return { seconds: own.length % 2 ? own[m] : (own[m - 1] + own[m]) / 2, tier: 1 };
  }
  const f = p.hourOfWeek && p.hourOfWeek.length === 168 ? p.hourOfWeek[d.getDay() * 24 + hour] : undefined;
  if (typeof f === 'number' && Number.isFinite(f) && f >= 0.5 && f <= 5) return { seconds: p.baseSeconds * f, tier: 2 };
  return { seconds: p.baseSeconds + Math.max(SLACK_MIN_SECONDS, SLACK_FRACTION * p.baseSeconds), tier: 3 };
}

export async function readTrafficProfile(dir = process.env.KEYS_DIR ?? join(process.cwd(), 'keys')): Promise<number[] | null> {
  try {
    const raw = JSON.parse(await readFile(join(dir, 'traffic-profiles.json'), 'utf-8')) as { hourOfWeek?: unknown };
    return Array.isArray(raw.hourOfWeek) && raw.hourOfWeek.length === 168 ? (raw.hourOfWeek as number[]) : null;
  } catch { return null; }
}
