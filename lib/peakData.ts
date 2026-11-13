// Reads the NV usage the upload wrote (Influx nve_daily_peak) with each day's high temperature, and
// builds the demand planner's room per night (lib/peakForecast.ts). Every peak day gets a high:
// rows without high_f are filled from Open-Meteo's archive (location rounded to 0.1 degree) and the
// high is written back onto the same Influx row. Never throws: a failed read is "no history", and
// the planner then sees no room under the peak (the plain lowest-amps plan). Per-day figures only.
import { influxTarget, writeLines } from './chargeSessionInflux.ts';
import { pacificFields } from './pacificTime.ts';
import { nightForecast, type PeakDay } from './peakForecast.ts';
import type { PeakNightIn } from './peakPlan.ts';

type Env = Record<string, string | undefined>;
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const MEASUREMENT = 'nve_daily_peak';
const DAYS_BACK = 800;
const TTL_MS = 6 * 3_600_000;
const TIMEOUT_MS = 15_000;
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';

export interface PeakRow {
  ms: number;                   // the row's Influx time (local noon of the day)
  date: string;                 // local YYYY-MM-DD
  dayKw: number | null;
  houseNightKw: number | null;
  tempF: number | null;         // high_f
}

let cache: { at: number; rows: PeakRow[] } | null = null;
export function resetPeakCache(): void { cache = null; }

export function peakQuery(bucket: string): string {
  return `from(bucket: ${JSON.stringify(bucket)}) |> range(start: -${DAYS_BACK}d) `
    + `|> filter(fn: (r) => r._measurement == "${MEASUREMENT}" and (r._field == "day_peak_kw" or r._field == "house_night_kw" or r._field == "high_f")) `
    + `|> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")`;
}

// Annotated CSV from Flux (one header per table) -> per-day rows.
export function parsePeakCsv(text: string): PeakRow[] {
  const byDate = new Map<string, PeakRow>();
  let cols: string[] | null = null;
  const num = (s: string | undefined) => { const n = s === undefined || s === '' ? NaN : Number(s); return Number.isFinite(n) ? n : null; };
  for (const raw of text.split(/\r?\n/)) {
    if (!raw) { cols = null; continue; }
    if (raw.startsWith('#')) continue;
    const f = raw.split(',');
    if (f.includes('_time')) { cols = f; continue; }
    if (!cols) continue;
    const at = (name: string) => { const i = cols!.indexOf(name); return i >= 0 ? f[i] : undefined; };
    const ms = Date.parse(at('_time') ?? '');
    if (!Number.isFinite(ms)) continue;
    const date = pacificFields(ms).date;
    const prev = byDate.get(date);
    byDate.set(date, {
      ms, date,
      dayKw: num(at('day_peak_kw')) ?? prev?.dayKw ?? null,
      houseNightKw: num(at('house_night_kw')) ?? prev?.houseNightKw ?? null,
      tempF: num(at('high_f')) ?? prev?.tempF ?? null,
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function roundCoord(x: number): number { return Math.round(x * 10) / 10; }

export function highsUrl(lat: number, lon: number, start: string, end: string): string {
  return `${ARCHIVE_URL}?latitude=${roundCoord(lat)}&longitude=${roundCoord(lon)}&start_date=${start}&end_date=${end}`
    + '&daily=temperature_2m_max&temperature_unit=fahrenheit&timezone=America%2FLos_Angeles';
}

export function parseHighs(body: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const d = (body as { daily?: { time?: unknown; temperature_2m_max?: unknown } } | null)?.daily;
  if (!d || !Array.isArray(d.time) || !Array.isArray(d.temperature_2m_max)) return out;
  d.time.forEach((t, i) => {
    const v = (d.temperature_2m_max as unknown[])[i];
    if (typeof t === 'string' && typeof v === 'number' && Number.isFinite(v)) out.set(t, v);
  });
  return out;
}

export function highLines(rows: Array<{ ms: number; tempF: number }>): string[] {
  return rows.map((r) => `${MEASUREMENT} high_f=${Math.round(r.tempF * 10) / 10} ${r.ms}`);
}

// Fills rows without a high from the archive and writes those highs back. Returns the rows, filled
// where the archive had the day.
export async function fillHighs(
  rows: PeakRow[], lat: number | null, lon: number | null, env: Env, fetchImpl: FetchLike,
): Promise<PeakRow[]> {
  const missing = rows.filter((r) => r.tempF === null);
  if (!missing.length || lat === null || lon === null) return rows;
  const today = pacificFields(Date.now()).date;
  const dates = missing.map((r) => r.date).filter((d) => d <= today).sort();
  if (!dates.length) return rows;
  const res = await fetchImpl(highsUrl(lat, lon, dates[0], dates[dates.length - 1]), {
    method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`weather archive HTTP ${res.status}`);
  const highs = parseHighs(JSON.parse(await res.text()));
  const filled: Array<{ ms: number; tempF: number }> = [];
  const out = rows.map((r) => {
    if (r.tempF !== null) return r;
    const h = highs.get(r.date);
    if (h === undefined) return r;
    filled.push({ ms: r.ms, tempF: h });
    return { ...r, tempF: h };
  });
  const target = influxTarget(env);
  if (target && filled.length) {
    try {
      await writeLines(highLines(filled), target, fetchImpl as Parameters<typeof writeLines>[2], TIMEOUT_MS);
    } catch (e) {
      console.error('[peak-plan] writing daily highs failed:', e instanceof Error ? e.message : e);
    }
  }
  return out;
}

export async function loadPeakDays(opts: {
  workDays: Set<number> | null; lat: number | null; lon: number | null;
  now?: number; env?: Env; fetchImpl?: FetchLike;
}): Promise<PeakDay[]> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  try {
    if (!cache || now - cache.at > TTL_MS) {
      const target = influxTarget(env);
      if (!target) return [];
      const u = new URL(target.url);
      const url = `${u.origin}${u.pathname.replace(/\/write$/, '/query')}?org=${encodeURIComponent(u.searchParams.get('org') ?? '')}`;
      const res = await fetchImpl(url, {
        method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS), body: peakQuery(u.searchParams.get('bucket') ?? ''),
        headers: { Authorization: target.headers.Authorization, 'Content-Type': 'application/vnd.flux', Accept: 'application/csv' },
      });
      if (!res.ok) throw new Error(`influx query HTTP ${res.status}`);
      let rows = parsePeakCsv(await res.text());
      try {
        rows = await fillHighs(rows, opts.lat, opts.lon, env, fetchImpl);
      } catch (e) {
        console.error('[peak-plan] daily highs unavailable:', e instanceof Error ? e.message : e);
      }
      cache = { at: now, rows };
    }
    // Days before the calendar's first shift are of unknown kind, not days off.
    const wd = opts.workDays;
    const calFrom = wd && wd.size ? Math.min(...wd) : null;
    return cache.rows.map((r) => {
      const [y, m, d] = r.date.split('-').map(Number);
      const day = Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
      const isWork = wd && calFrom !== null && day >= calFrom ? wd.has(day) : null;
      return { date: r.date, dayKw: r.dayKw, houseNightKw: r.houseNightKw, tempF: r.tempF, isWork };
    });
  } catch (e) {
    console.error('[peak-plan] NV usage read failed:', e instanceof Error ? e.message : e);
    return [];
  }
}

// Room under the peak for the serve day and the two after it. highs[k]: the forecast high of
// serveDay + k (null = unknown; the forecast then ignores temperature).
export function peakNightsFor(
  days: PeakDay[], serveDay: number, workDays: Set<number> | null, highs: Array<number | null>, houseSince: string | null,
): PeakNightIn[] {
  const out: PeakNightIn[] = [];
  for (let k = 0; k < 3; k++) {
    const day = serveDay + k;
    const month = new Date(day * 86_400_000).getUTCMonth() + 1;
    const f = nightForecast(days, { month, isWork: workDays ? workDays.has(day) : null, tempF: highs[k] ?? null }, houseSince);
    out.push({ aimKw: f.aimKw, houseKw: f.houseKw, headroomKw: f.headroomKw });
  }
  return out;
}
