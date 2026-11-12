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
import { localDayNumber, type Shift } from './chargePlan.ts';

export type { Shift };

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

export const TIME_OFF = /\b(PTO|VC|TDO|OFF|FLOAT)\b|time ?off/i;
const OPEN_SHIFT = /^CATEGORIES[;:].*\bopen[ -]?shift\b/i;
const DEFAULT_SHIFT_MS = 10 * 3_600_000;   // a shift with no DTEND (they are 10h)

export interface ShiftCalendar {
  workDays: Set<number>;      // shift days minus time-off days; one stable Set per fetch
  shifts: Shift[];            // timed D<n>A / D<n>P shifts on workDays, with their end
  timeOffDays: Set<number>;
}

export function parseShiftCalendar(ics: string): ShiftCalendar {
  const lines = ics.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const shiftDays = new Set<number>();
  const timeOffDays = new Set<number>();
  const all: Shift[] = [];
  let depth = 0;   // inside VEVENT (1) or a component nested in it (>1)
  let start: ReturnType<typeof parseIcsTime> = null;
  let end: ReturnType<typeof parseIcsTime> = null;
  let cancelled = false;
  let open = false;
  let summary = '';
  let uid = '';
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { depth = 1; start = null; end = null; cancelled = false; open = false; summary = ''; uid = ''; continue; }
    if (!depth) continue;
    if (line.startsWith('BEGIN:')) { depth++; continue; }
    if (line.startsWith('END:')) {
      if (--depth === 0 && start && !cancelled && !open) {
        if (TIME_OFF.test(summary) && !SHIFT_CODE.test(summary)) {   // a coded shift title is a shift even if it says "float"
          // DTEND is exclusive for all-day entries; a timed one covers the
          // day of its last instant.
          const last = end && end.ms > start.ms ? localDayNumber(end.ms - 1) : localDayNumber(start.ms);
          for (let d = localDayNumber(start.ms); d <= Math.max(last, localDayNumber(start.ms)); d++) timeOffDays.add(d);
        } else if (!start.allDay && SHIFT_CODE.test(summary)) {
          const day = localDayNumber(start.ms);
          shiftDays.add(day);
          all.push({ day, startMs: start.ms, endMs: end && end.ms > start.ms ? end.ms : start.ms + DEFAULT_SHIFT_MS, ...(uid ? { uid } : {}) });
        }
      }
      continue;
    }
    if (depth !== 1) continue;
    if (line.startsWith('DTSTART')) start = parseIcsTime(line);
    else if (line.startsWith('DTEND')) end = parseIcsTime(line);
    else if (/^SUMMARY[;:]/.test(line)) summary = line.slice(line.indexOf(':') + 1);
    else if (line.startsWith('UID:')) uid = line.slice(4);
    else if (OPEN_SHIFT.test(line)) open = true;
    else if (line.startsWith('STATUS:CANCELLED')) cancelled = true;
  }
  const workDays = new Set([...shiftDays].filter((d) => !timeOffDays.has(d)));
  return { workDays, shifts: all.filter((s) => workDays.has(s.day)), timeOffDays };
}

export function workDaysFromIcs(ics: string): Set<number> {
  return parseShiftCalendar(ics).workDays;
}

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface SourceOptions {
  refresh?: boolean;   // fetch now, ignoring the 6h cache and the retry wait (the 08:15 / 23:00 slots)
}

// One cache per process: refreshed every REFRESH_MS (or on `refresh`); on a
// failed fetch the last good calendar is kept and the next unforced try waits
// RETRY_MS. Never throws.
export function createShiftCalendarSource() {
  let cache: { cal: ShiftCalendar; atMs: number } | null = null;
  let lastTryMs = -Infinity;
  return async function getShiftCalendar(
    now = Date.now(),
    env: Record<string, string | undefined> = process.env,
    fetchImpl: FetchLike = fetch as unknown as FetchLike,
    opts: SourceOptions = {},
  ): Promise<ShiftCalendar | null> {
    const raw = env.SHIFTS_ICS_URL;
    if (!raw) return null;
    if (!opts.refresh) {
      if (cache && now - cache.atMs < REFRESH_MS) return cache.cal;
      if (now - lastTryMs < RETRY_MS) return cache?.cal ?? null;
    }
    lastTryMs = now;
    const url = raw.replace(/^webcal:\/\//i, 'https://');
    try {
      const headers: Record<string, string> = {};
      if (env.SHIFTS_ICS_USER) {
        headers.Authorization = 'Basic ' + Buffer.from(`${env.SHIFTS_ICS_USER}:${env.SHIFTS_ICS_PASSWORD ?? ''}`).toString('base64');
      }
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const cal = parseShiftCalendar(await res.text());
      cache = { cal, atMs: now };
      return cal;
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e).split(url).join('<url>').split(raw).join('<url>').slice(0, 160);
      console.error('[shifts] calendar fetch failed:', msg);
      return cache?.cal ?? null;
    }
  };
}

type CalendarSource = ReturnType<typeof createShiftCalendarSource>;

// Work days only, as before, from any calendar source.
export function createWorkDaysSource(source: CalendarSource = createShiftCalendarSource()) {
  return async function getWorkDays(...args: Parameters<CalendarSource>): Promise<Set<number> | null> {
    return (await source(...args))?.workDays ?? null;
  };
}

// One shared cache for the process: both exports read the same fetch.
export const getShiftCalendar = createShiftCalendarSource();
export const getWorkDays = createWorkDaysSource(getShiftCalendar);
