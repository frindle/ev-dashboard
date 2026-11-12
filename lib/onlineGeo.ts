// Public OpenStreetMap services for places outside Nevada (EV charge plan #8).
// Only Nevada map data is kept on the LAN (docs/valhalla-nominatim.md). A
// location the LAN Nominatim cannot place, or a route with an end outside
// Nevada (or one the LAN Valhalla cannot route), goes to the public Nominatim
// and the FOSSGIS Valhalla instead.
//
// Both services allow at most 1 request a second and want a User-Agent that
// names the application, and FOSSGIS asks apps not to hard-code its URL. So:
// the URLs come from env (defaults below), requests to one host are spaced at
// least ONLINE_GAP_MS apart, and the User-Agent names this app only (no
// person, no contact address). Off with GEO_ONLINE=0.
//
// What leaves the LAN: a location text the LAN copy could not place, and route
// end points rounded to 0.01 degrees (about 1 km), so home's exact point never
// goes out. Nothing is logged beyond an error name.

export const ONLINE_NOMINATIM_DEFAULT = 'https://nominatim.openstreetmap.org';
export const ONLINE_VALHALLA_DEFAULT = 'https://valhalla1.openstreetmap.de';
export const ONLINE_UA = 'ev-dashboard-trip-planner/1.0 (self-hosted)';
export const ONLINE_GAP_MS = 1100;

type Env = Record<string, string | undefined>;

export function onlineGeo(env: Env = process.env): { nominatim: string | null; valhalla: string | null } {
  if (env.GEO_ONLINE === '0') return { nominatim: null, valhalla: null };
  const pick = (v: string | undefined, d: string) => (v === undefined ? d : v.trim() || null);
  return { nominatim: pick(env.NOMINATIM_ONLINE_URL, ONLINE_NOMINATIM_DEFAULT), valhalla: pick(env.VALHALLA_ONLINE_URL, ONLINE_VALHALLA_DEFAULT) };
}

// Requests to one host, at least ONLINE_GAP_MS apart (a queue, not a drop).
const nextAt = new Map<string, number>();
let sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export function _setSleepForTests(f: ((ms: number) => Promise<void>) | null): void {
  sleep = f ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  nextAt.clear();
}

export async function spaced<T>(url: string, f: () => Promise<T>, nowMs = Date.now()): Promise<T> {
  let host = url;
  try { host = new URL(url).host; } catch { /* keep the text */ }
  const at = Math.max(nowMs, nextAt.get(host) ?? 0);
  nextAt.set(host, at + ONLINE_GAP_MS);
  if (at > nowMs) await sleep(at - nowMs);
  return f();
}

export const round2 = (x: number) => Math.round(x * 100) / 100;

// Nevada as a simplified polygon [lon, lat], drawn a little inside the real
// line along the California diagonal, the Colorado River and the Utah/Arizona
// meridian. A point near the border may test as outside: that only means its
// routes go to the online service, which covers both sides.
const NV: [number, number][] = [
  [-119.99, 41.99], [-114.05, 41.99], [-114.05, 36.19], [-114.74, 36.02], [-114.66, 35.03], [-119.99, 39.0],
];

export function inNevada(p: { lat: number; lon: number }): boolean {
  let inside = false;
  for (let i = 0, j = NV.length - 1; i < NV.length; j = i++) {
    const [xi, yi] = NV[i], [xj, yj] = NV[j];
    if ((yi > p.lat) !== (yj > p.lat) && p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
