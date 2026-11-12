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
import { parseIcsEvents, zonedMs, type LatLon } from './ics.ts';

export type { Shift };

export const SHIFT_CODE = /D\d+[AP]/;
const REFRESH_MS = 6 * 3_600_000;
const RETRY_MS = 15 * 60_000;

export { zonedMs };

export const TIME_OFF = /\b(PTO|VC|TDO|OFF|FLOAT)\b|time ?off/i;
const DEFAULT_SHIFT_MS = 10 * 3_600_000;   // a shift with no DTEND (they are 10h)

export interface ShiftCalendar {
  workDays: Set<number>;      // shift days minus time-off days; one stable Set per fetch
  shifts: Shift[];            // timed D<n>A / D<n>P shifts on workDays, with their end
  timeOffDays: Set<number>;
  // Where work is, from the first shift event that has a location (trips, #8); null when none.
  workPlace: { location: string; geo: LatLon | null } | null;
}

export function parseShiftCalendar(ics: string): ShiftCalendar {
  const shiftDays = new Set<number>();
  const timeOffDays = new Set<number>();
  const all: Shift[] = [];
  let workPlace: ShiftCalendar['workPlace'] = null;
  for (const ev of parseIcsEvents(ics)) {
    const { start, end, summary, uid } = ev;
    if (!start || ev.cancelled || ev.open) continue;
    if (TIME_OFF.test(summary) && !SHIFT_CODE.test(summary)) {   // a coded shift title is a shift even if it says "float"
      // DTEND is exclusive for all-day entries; a timed one covers the
      // day of its last instant.
      const last = end && end.ms > start.ms ? localDayNumber(end.ms - 1) : localDayNumber(start.ms);
      for (let d = localDayNumber(start.ms); d <= Math.max(last, localDayNumber(start.ms)); d++) timeOffDays.add(d);
    } else if (!start.allDay && SHIFT_CODE.test(summary)) {
      const day = localDayNumber(start.ms);
      shiftDays.add(day);
      if (!workPlace && (ev.location || ev.structuredGeo || ev.geo)) workPlace = { location: ev.location, geo: ev.structuredGeo ?? ev.geo };
      all.push({ day, startMs: start.ms, endMs: end && end.ms > start.ms ? end.ms : start.ms + DEFAULT_SHIFT_MS, ...(uid ? { uid } : {}) });
    }
  }
  const workDays = new Set([...shiftDays].filter((d) => !timeOffDays.has(d)));
  return { workDays, shifts: all.filter((s) => workDays.has(s.day)), timeOffDays, workPlace };
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
