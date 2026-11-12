// The personal calendar (EV charge plan #8): errands and trips, from a second
// ICS feed. Inert unless PERSONAL_CAL_URL is set: nothing is fetched and the
// plan is untouched. Only events with a location count. Event titles are
// never kept (the planner has no use for them) and nothing here is logged but
// counts.
//
// Env: PERSONAL_CAL_URL (a Nextcloud `...?export` URL, webcal:// is fetched as
// https://), optional PERSONAL_CAL_USER + PERSONAL_CAL_PASSWORD for basic auth.
import { localDayNumber } from './chargePlan.ts';
import { parseIcsEvents, type LatLon } from './ics.ts';

export const TRIP_DAYS_AHEAD = 7;
const REFRESH_MS = 6 * 3_600_000;
const RETRY_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

export type HomeTag = 'home' | 'straight';

export interface PersonalEvent {
  uid: string;
  day: number;            // local start day
  startMs: number;        // all-day: local midnight of the first day
  endMs: number;          // all-day: exclusive end (midnight after the last day)
  allDay: boolean;
  multiDay: boolean;      // away overnight: 24h or more, or an all-day event over 2+ days
  location: string;       // in memory only
  geo: LatLon | null;     // structured location first, then GEO
  tag: HomeTag | null;    // #home / #straight in the notes
}

export function tagFromNotes(notes: string): HomeTag | null {
  const m = /(?:^|[^\w#])#(home|straight)\b/i.exec(notes);
  return m ? (m[1].toLowerCase() as HomeTag) : null;
}

// Every non-cancelled event that has a location (or a map point).
export function parsePersonalEvents(ics: string): PersonalEvent[] {
  const out: PersonalEvent[] = [];
  for (const e of parseIcsEvents(ics)) {
    if (!e.start || e.cancelled || e.open) continue;
    if (!e.location && !e.structuredGeo && !e.geo) continue;
    const startMs = e.start.ms;
    const endMs = e.end && e.end.ms > startMs ? e.end.ms : startMs;
    const allDay = e.start.allDay;
    const multiDay = allDay
      ? localDayNumber(Math.max(startMs, endMs - 1)) > localDayNumber(startMs)
      : endMs - startMs >= DAY_MS;
    out.push({
      uid: e.uid, day: localDayNumber(startMs), startMs, endMs, allDay, multiDay,
      location: e.location, geo: e.structuredGeo ?? e.geo, tag: tagFromNotes(e.description),
    });
  }
  return out;
}

// Events starting today through `days` ahead, in time order.
export function eventsWithin(all: PersonalEvent[], nowMs: number, days = TRIP_DAYS_AHEAD): PersonalEvent[] {
  const today = localDayNumber(nowMs);
  return all.filter((e) => e.day >= today && e.day <= today + days).sort((a, b) => a.startMs - b.startMs);
}

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export const personalCalendarOn = (env: Record<string, string | undefined> = process.env): boolean => !!env.PERSONAL_CAL_URL;

// One cache per process, like the shift calendar: 6h, a failed fetch keeps the
// last good copy and waits 15 min. Never throws; null when off or nothing yet.
export function createPersonalCalendarSource() {
  let cache: { events: PersonalEvent[]; atMs: number } | null = null;
  let lastTryMs = -Infinity;
  return async function getPersonalEvents(
    now = Date.now(),
    env: Record<string, string | undefined> = process.env,
    fetchImpl: FetchLike = fetch as unknown as FetchLike,
    opts: { refresh?: boolean } = {},
  ): Promise<PersonalEvent[] | null> {
    const raw = env.PERSONAL_CAL_URL;
    if (!raw) return null;
    if (!opts.refresh) {
      if (cache && now - cache.atMs < REFRESH_MS) return cache.events;
      if (now - lastTryMs < RETRY_MS) return cache?.events ?? null;
    }
    lastTryMs = now;
    const url = raw.replace(/^webcal:\/\//i, 'https://');
    try {
      const headers: Record<string, string> = {};
      if (env.PERSONAL_CAL_USER) {
        headers.Authorization = 'Basic ' + Buffer.from(`${env.PERSONAL_CAL_USER}:${env.PERSONAL_CAL_PASSWORD ?? ''}`).toString('base64');
      }
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      cache = { events: parsePersonalEvents(await res.text()), atMs: now };
      return cache.events;
    } catch (e) {
      console.error('[trips] calendar fetch failed:', e instanceof Error ? e.name : 'error');
      return cache?.events ?? null;
    }
  };
}

export const getPersonalEvents = createPersonalCalendarSource();
