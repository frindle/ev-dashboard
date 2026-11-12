// Pushover alerts for the trip planner (EV charge plan #8), each sent once
// (keys go in the plan-alerts store). Pure. A push carries a day, miles,
// percentages and a time, never an event title, a place or coordinates, and
// the tap-through link is the /trips page for a day.
import type { Alert } from './planAlerts.ts';

const T = 'Rivian trip plan';

export interface TripSummary {
  day: number;
  dateLabel: string;           // e.g. "Tue 11/17"
  miles: number;
  needPct: number;
  targetPct: number;
  byMs: number | null;
  raise: boolean;              // the trip drives the plan
  multiDay: boolean;
  unplaced: number;            // events that could not be placed
  overlaps: number;            // events overlapping the shift, still open
  limitPct: number | null;     // the car's charge limit
  reachable: boolean | null;   // overridePlan feasible, when it could be worked out
}

export interface TripAlertCtx {
  nowMs: number;
  today: number;
  serveDay: number;            // the day tonight's charge serves
  sent: Set<string>;
  days: TripSummary[];
  openBefore: number[];        // overlap days that were open on the last run
  dashboardUrl: string | null;
  slot: 'forecast' | 'update' | null;
}

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const link = (url: string | null, day: number, title: string) =>
  (url ? { url: `${url.replace(/\/+$/, '')}/trips?day=${day}`, urlTitle: title } : undefined);

export function tripAlerts(c: TripAlertCtx): Alert[] {
  const d = new Date(c.nowMs);
  const min = d.getHours() * 60 + d.getMinutes();
  const out: Alert[] = [];
  const add = (a: Alert) => { if (!c.sent.has(a.key)) out.push(a); };
  const daytime = min >= 8 * 60 && min < 22 * 60;
  for (const t of c.days) {
    if (t.day < c.today) continue;
    const l = link(c.dashboardUrl, t.day, 'Open trips');
    if (t.raise && t.byMs !== null) {
      add({ key: `trip-planned:${t.day}`, title: T, priority: 0, link: l,
        message: `Trip planned for ${t.dateLabel}: about ${Math.round(t.miles)} mi, ${Math.round(t.targetPct)}% by ${hhmm(t.byMs)}.` });
      if (t.limitPct !== null && t.targetPct > t.limitPct) {
        add({ key: `trip-limit:${t.day}:${Math.round(t.targetPct)}`, title: T, priority: 0, link: l,
          message: `Raise the charge limit to ${Math.round(t.targetPct)}% in the Rivian app for ${t.dateLabel}, then set it back to 70% after.` });
      }
      if (t.reachable === false) {
        add({ key: `trip-unreachable:${t.day}`, title: T, priority: 1, link: l,
          message: `The charge for ${t.dateLabel} cannot reach ${Math.round(t.targetPct)}% by ${hhmm(t.byMs)} at the available charge hours.` });
      }
    }
    if (t.multiDay) {
      add({ key: `trip-multiday:${t.day}`, title: T, priority: 0, link: l,
        message: `Multi-day trip starting ${t.dateLabel}: only the outbound leg is planned. Charging while away is not planned.` });
    }
    if (t.unplaced > 0 && daytime) {
      add({ key: `trip-unplaced:${t.day}`, title: T, priority: 0, link: link(c.dashboardUrl, t.day, 'Place it'),
        message: `${t.unplaced === 1 ? 'An event' : `${t.unplaced} events`} on ${t.dateLabel} ${t.unplaced === 1 ? 'has a location' : 'have locations'} that could not be placed. Pick the place on the trips page.` });
    }
    if (t.overlaps > 0) {
      const ol = link(c.dashboardUrl, t.day, 'Choose');
      const affectsTonight = t.day === c.serveDay;
      const first = daytime || (affectsTonight && c.slot === 'update');
      if (first) {
        add({ key: `trip-overlap:${t.day}`, title: T, priority: 0, link: ol,
          message: `A personal event on ${t.dateLabel} overlaps your shift. The plan counts it as a round trip from work until you choose.` });
      }
      if (min >= 23 * 60) {
        add({ key: `trip-overlap-2300:${c.today}:${t.day}`, title: T, priority: 1, link: ol,
          message: `Event overlapping your ${t.dateLabel} shift is still open at 23:00. Choose before the car starts charging.` });
      }
      if (min >= 8 * 60 + 15 && min < 12 * 60 && t.day >= c.today && c.sent.has(`trip-overlap:${t.day}`)) {
        add({ key: `trip-overlap-0815:${c.today}:${t.day}`, title: T, priority: 0, link: ol,
          message: `Event overlapping your ${t.dateLabel} shift is still open this morning.` });
      }
    }
  }
  // Fixed: an overlap that was open and is now resolved or gone.
  const stillOpen = new Set(c.days.filter((t) => t.overlaps > 0).map((t) => t.day));
  for (const day of c.openBefore) {
    if (stillOpen.has(day) || day < c.today) continue;
    add({ key: `trip-overlap-fixed:${day}`, title: T, priority: 0,
      message: 'Overlapping event settled. The charge plan has been updated.' });
  }
  return out;
}
