// Coordinates for a personal-calendar event (EV charge plan #8), in order:
// the event's X-APPLE-STRUCTURED-LOCATION geo, its GEO, a pick saved in
// keys/geo-overrides.json (by UID), then the self-hosted Nominatim
// (NOMINATIM_URL, LAN, Nevada only), then the public Nominatim for anything
// the LAN copy does not know (lib/onlineGeo.ts; off with GEO_ONLINE=0).
// Unplaced -> null (flagged on /trips, with a push).
//
// Location text goes to the LAN Nominatim first and to the public one only
// when the LAN copy found nothing. It is never logged; failures log a status only.
import type { LatLon } from './ics.ts';
import { ONLINE_UA, onlineGeo, spaced } from './onlineGeo.ts';

export type GeoSource = 'structured' | 'event' | 'override' | 'nominatim' | 'online';
export interface Placed extends LatLon { source: GeoSource }

// uid -> point; WORK_KEY holds the one-time work-location pick.
export type GeoOverrides = Record<string, LatLon>;
export const WORK_KEY = '__work__';

type FetchLike = (url: string, init: { signal: AbortSignal; headers?: Record<string, string> }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface PlaceHit extends LatLon { label: string; online?: true }

const cache = new Map<string, { hits: PlaceHit[]; atMs: number }>();
const HIT_TTL_MS = 7 * 86_400_000;
const MISS_TTL_MS = 12 * 3_600_000;   // an unplaceable event retries twice a day, so an array disk can sleep

export function clearGeocodeCache(): void { cache.clear(); }

async function nominatim(base: string, q: string, limit: number, online: boolean, fetchImpl: FetchLike): Promise<PlaceHit[] | null> {
  try {
    const url = `${base.replace(/\/+$/, '')}/search?format=jsonv2&limit=${limit}${online ? '&countrycodes=us' : ''}&q=${encodeURIComponent(q)}`;
    const get = () => fetchImpl(url, { signal: AbortSignal.timeout(8_000), ...(online ? { headers: { 'User-Agent': ONLINE_UA } } : {}) });
    const res = online ? await spaced(url, get) : await get();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as Array<{ lat?: string; lon?: string; display_name?: string }>;
    const hits: PlaceHit[] = [];
    for (const r of Array.isArray(body) ? body : []) {
      const lat = parseFloat(r.lat ?? ''), lon = parseFloat(r.lon ?? '');
      if (Number.isFinite(lat) && Number.isFinite(lon)) hits.push({ lat, lon, label: String(r.display_name ?? '').slice(0, 200), ...(online ? { online: true as const } : {}) });
    }
    return hits;
  } catch (e) {
    console.error(`[trips] ${online ? 'online ' : ''}geocoder failed:`, (e instanceof Error ? e.name : 'error'));
    return null;
  }
}

// Up to `limit` matches for a text: the LAN Nominatim, then the public one when
// the LAN copy has none; [] when both are off, unreachable or find nothing.
export async function searchPlaces(
  text: string, env: Record<string, string | undefined> = process.env, fetchImpl: FetchLike = fetch as unknown as FetchLike,
  limit = 5, nowMs = Date.now(),
): Promise<PlaceHit[]> {
  const local = env.NOMINATIM_URL || null;
  const online = onlineGeo(env).nominatim;
  const q = text.trim();
  if ((!local && !online) || !q) return [];
  const key = `${limit}|${q.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && nowMs - hit.atMs < (hit.hits.length ? HIT_TTL_MS : MISS_TTL_MS)) return hit.hits;
  let hits = local ? await nominatim(local, q, limit, false, fetchImpl) : null;
  let answered = hits !== null;
  if (!hits?.length && online) {
    const o = await nominatim(online, q, limit, true, fetchImpl);
    if (o !== null) { hits = o; answered = true; }
  }
  if (!answered) return [];          // both failed: not cached, the next run tries again
  cache.set(key, { hits: hits ?? [], atMs: nowMs });
  return hits ?? [];
}

export interface Placeable { uid: string; location: string; geo: LatLon | null }

export async function placeEvent(
  ev: Placeable, overrides: GeoOverrides, env: Record<string, string | undefined> = process.env,
  fetchImpl?: FetchLike, nowMs?: number,
): Promise<Placed | null> {
  if (ev.geo) return { ...ev.geo, source: 'event' };
  const o = ev.uid ? overrides[ev.uid] : undefined;
  if (o) return { ...o, source: 'override' };
  if (!ev.location) return null;
  const [h] = await searchPlaces(ev.location, env, fetchImpl, 1, nowMs);
  return h ? { lat: h.lat, lon: h.lon, source: h.online ? 'online' : 'nominatim' } : null;
}
