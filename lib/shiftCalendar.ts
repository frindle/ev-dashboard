// Work days from the Work Shifts calendar, an ICS feed (the iCloud published
// calendar now, Nextcloud's export URL later). A work day is the local start
// date of a timed event whose title has a shift code, D<n>A or D<n>P (Penn,
// 2026-11-07; 2026 has 212 P shifts, 10h from 10:00-14:00, and 3 A shifts,
// 10h from 03:00 or 06:00). Other events are not shifts. Recurring events
// (RRULE) are not expanded: the shift exporter writes single events.
//
// Env: SHIFTS_ICS_URL (webcal:// is fetched as https://), optional
// SHIFTS_ICS_USER + SHIFTS_ICS_PASSWORD for basic auth (a Nextcloud app
// password). The URL is a secret and is never logged.
import { localDayNumber } from './chargePlan.ts';

export const SHIFT_CODE = /D\d+[AP]/;
const REFRESH_MS = 6 * 3_600_000;
const RETRY_MS = 15 * 60_000;

function tzOffsetMs(ms: number, tz: string): number {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
}

// Wall-clock time in `tz` (process local when absent or unknown) -> epoch ms.
export function zonedMs(y: number, mo: number, d: number, h: number, mi: number, s: number, tz?: string): number {
  if (tz) {
    try {
      const guess = Date.UTC(y, mo, d, h, mi, s);
      const first = guess - tzOffsetMs(guess, tz);
      return guess - tzOffsetMs(first, tz);
    } catch { /* unknown TZID: fall through to local */ }
  }
  return new Date(y, mo, d, h, mi, s).getTime();
}

function parseIcsTime(line: string): { ms: number; allDay: boolean } | null {
  const m = /^DT(?:START|END)((?:;[^:]*)?):(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/.exec(line);
  if (!m) return null;
  const [, params, y, mo, d, h, mi, s, z] = m;
  if (h === undefined) return { ms: new Date(+y, +mo - 1, +d).getTime(), allDay: true };
  if (z) return { ms: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s), allDay: false };
  const tz = /TZID=("?)([^;:"]+)\1/.exec(params)?.[2];
  return { ms: zonedMs(+y, +mo - 1, +d, +h, +mi, +s, tz), allDay: false };
}

export function workDaysFromIcs(ics: string): Set<number> {
  const lines = ics.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const days = new Set<number>();
  let depth = 0;   // inside VEVENT (1) or a component nested in it (>1)
  let start: ReturnType<typeof parseIcsTime> = null;
  let cancelled = false;
  let summary = '';
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { depth = 1; start = null; cancelled = false; summary = ''; continue; }
    if (!depth) continue;
    if (line.startsWith('BEGIN:')) { depth++; continue; }
    if (line.startsWith('END:')) {
      if (--depth === 0 && start && !start.allDay && !cancelled && SHIFT_CODE.test(summary)) {
        days.add(localDayNumber(start.ms));
      }
      continue;
    }
    if (depth !== 1) continue;
    if (line.startsWith('DTSTART')) start = parseIcsTime(line);
    else if (/^SUMMARY[;:]/.test(line)) summary = line.slice(line.indexOf(':') + 1);
    else if (line.startsWith('STATUS:CANCELLED')) cancelled = true;
  }
  return days;
}

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

// One cache per process: refreshed every REFRESH_MS; on a failed fetch the
// last good set is kept and the next try waits RETRY_MS. Never throws.
export function createWorkDaysSource() {
  let cache: { days: Set<number>; atMs: number } | null = null;
  let lastTryMs = -Infinity;
  return async function getWorkDays(
    now = Date.now(),
    env: Record<string, string | undefined> = process.env,
    fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ): Promise<Set<number> | null> {
    const raw = env.SHIFTS_ICS_URL;
    if (!raw) return null;
    if (cache && now - cache.atMs < REFRESH_MS) return cache.days;
    if (now - lastTryMs < RETRY_MS) return cache?.days ?? null;
    lastTryMs = now;
    const url = raw.replace(/^webcal:\/\//i, 'https://');
    try {
      const headers: Record<string, string> = {};
      if (env.SHIFTS_ICS_USER) {
        headers.Authorization = 'Basic ' + Buffer.from(`${env.SHIFTS_ICS_USER}:${env.SHIFTS_ICS_PASSWORD ?? ''}`).toString('base64');
      }
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const days = workDaysFromIcs(await res.text());
      cache = { days, atMs: now };
      return days;
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e).split(url).join('<url>').split(raw).join('<url>').slice(0, 160);
      console.error('[shifts] calendar fetch failed:', msg);
      return cache?.days ?? null;
    }
  };
}

export const getWorkDays = createWorkDaysSource();
