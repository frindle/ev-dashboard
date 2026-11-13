// Reads the NV usage the #9a upload wrote (Influx measurement nve_daily_peak) and builds the peak-cap
// inputs (lib/peakCap.ts) for the Rivian plan. Never throws: a failed read is "no history" and the cap
// stays off for the night. Per-day history only (no addresses, no account fields).
import { influxTarget } from './chargeSessionInflux.ts';
import type { PeakCapNight, PeakCapSetup } from './chargePlan.ts';
import { pacificFields } from './pacificTime.ts';
import { peakCapNight, type PeakDay } from './peakCap.ts';

type Env = Record<string, string | undefined>;
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const DAYS_BACK = 400;
const TTL_MS = 6 * 3_600_000;
const TIMEOUT_MS = 15_000;
let cache: { at: number; days: PeakDay[] } | null = null;

export function peakQuery(bucket: string): string {
  return `from(bucket: ${JSON.stringify(bucket)}) |> range(start: -${DAYS_BACK}d) `
    + `|> filter(fn: (r) => r._measurement == "nve_daily_peak" and (r._field == "day_peak_kw" or r._field == "house_night_kw")) `
    + `|> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")`;
}

/** Annotated CSV from Flux -> per-day rows. isWork is filled by the caller. */
export function parsePeakCsv(text: string): PeakDay[] {
  const out: PeakDay[] = [];
  let cols: string[] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw || raw.startsWith('#')) { continue; }
    const f = raw.split(',');
    if (f.includes('_time')) { cols = f; continue; }
    if (!cols) continue;
    const at = (name: string) => { const i = cols!.indexOf(name); return i >= 0 ? f[i] : undefined; };
    const t = Date.parse(at('_time') ?? '');
    if (!Number.isFinite(t)) continue;
    const num = (s: string | undefined) => { const n = s === undefined || s === '' ? NaN : Number(s); return Number.isFinite(n) ? n : null; };
    out.push({ date: pacificFields(t).date, dayKw: num(at('day_peak_kw')), houseNightKw: num(at('house_night_kw')), isWork: null });
  }
  return out;
}

export async function loadPeakDays(
  workDays: Set<number> | null, now = Date.now(), env: Env = process.env, fetchImpl?: FetchLike,
): Promise<PeakDay[]> {
  try {
    if (!cache || now - cache.at > TTL_MS) {
      const target = influxTarget(env);
      if (!target) return [];
      const u = new URL(target.url);
      const url = `${u.origin}${u.pathname.replace(/\/write$/, '/query')}?org=${encodeURIComponent(u.searchParams.get('org') ?? '')}`;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      try {
        const res = await (fetchImpl ?? (fetch as unknown as FetchLike))(url, {
          method: 'POST', signal: ctl.signal, body: peakQuery(u.searchParams.get('bucket') ?? ''),
          headers: { Authorization: target.headers.Authorization, 'Content-Type': 'application/vnd.flux', Accept: 'application/csv' },
        });
        if (!res.ok) throw new Error(`influx query HTTP ${res.status}`);
        cache = { at: now, days: parsePeakCsv(await res.text()) };
      } finally { clearTimeout(timer); }
    }
    return cache.days.map((d) => {
      const [y, m, dd] = d.date.split('-').map(Number);
      return { ...d, isWork: workDays ? workDays.has(Math.round(Date.UTC(y, m - 1, dd) / 86_400_000)) : null };
    });
  } catch (e) {
    console.error('[peak-cap] history read failed:', e instanceof Error ? e.message : e);
    return [];
  }
}

/** Cap inputs for tonight and the next 2 nights. `teslaKw` by serve day (the Tesla's planned kW that night). */
export function buildPeakCapSetup(
  enabled: boolean, serveDay: number, days: PeakDay[], workDays: Set<number> | null, forecastHighF: number | null,
  teslaKwByDay: ReadonlyMap<number, number> = new Map(),
): PeakCapSetup {
  const byDay = new Map<number, PeakCapNight>();
  for (let k = 0; k <= 2; k++) {
    const day = serveDay + k;
    const month = new Date(day * 86_400_000).getUTCMonth() + 1;
    byDay.set(day, peakCapNight(days, { month, isWork: workDays ? workDays.has(day) : null, tempF: k === 0 ? forecastHighF : null }, teslaKwByDay.get(day) ?? 0));
  }
  return { enabled, byDay };
}

