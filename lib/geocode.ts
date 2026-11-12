// Coordinates for a personal-calendar event (EV charge plan #8), in order:
// the event's X-APPLE-STRUCTURED-LOCATION geo, its GEO, a pick saved in
// keys/geo-overrides.json (by UID), then the self-hosted Nominatim
// (NOMINATIM_URL, LAN). Unplaced -> null (flagged on /trips).
//
// Location text only ever goes to the LAN Nominatim. It is never logged;
// failures log a status only.
import type { LatLon } from './ics.ts';

export type GeoSource = 'structured' | 'event' | 'override' | 'nominatim';
export interface Placed extends LatLon { source: GeoSource }

// uid -> point; WORK_KEY holds the one-time work-location pick.
export type GeoOverrides = Record<string, LatLon>;
export const WORK_KEY = '__work__';

type FetchLike = (url: string, init: { signal: AbortSignal; headers?: Record<string, string> }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface PlaceHit extends LatLon { label: string }

const cache = new Map<string, { hits: PlaceHit[]; atMs: number }>();
const HIT_TTL_MS = 7 * 86_400_000;
const MISS_TTL_MS = 30 * 60_000;

export function clearGeocodeCache(): void { cache.clear(); }

// Up to `limit` matches for a text, from Nominatim; [] when off, unreachable or no match.
export async function searchPlaces(
  text: string, env: Record<string, string | undefined> = process.env, fetchImpl: FetchLike = fetch as unknown as FetchLike,
  limit = 5, nowMs = Date.now(),
): Promise<PlaceHit[]> {
  const base = env.NOMINATIM_URL;
  const q = text.trim();
  if (!base || !q) return [];
  const key = `${limit}|${q.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && nowMs - hit.atMs < (hit.hits.length ? HIT_TTL_MS : MISS_TTL_MS)) return hit.hits;
  try {
    const url = `${base.replace(/\/+$/, '')}/search?format=jsonv2&limit=${limit}&q=${encodeURIComponent(q)}`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as Array<{ lat?: string; lon?: string; display_name?: string }>;
    const hits: PlaceHit[] = [];
    for (const r of Array.isArray(body) ? body : []) {
      const lat = parseFloat(r.lat ?? ''), lon = parseFloat(r.lon ?? '');
      if (Number.isFinite(lat) && Number.isFinite(lon)) hits.push({ lat, lon, label: String(r.display_name ?? '').slice(0, 200) });
    }
    cache.set(key, { hits, atMs: nowMs });
    return hits;
  } catch (e) {
    console.error('[trips] geocoder failed:', (e instanceof Error ? e.name : 'error'));
    return [];
  }
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
  return h ? { lat: h.lat, lon: h.lon, source: 'nominatim' } : null;
}
