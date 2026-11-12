// Trip planning from the personal calendar (EV charge plan #8). Pure apart
// from the injected route function: a day's located events become a stop
// order, route miles and seconds, then a battery need and an automatic
// "N% by departure" target. It is a separate layer on top of the plan: it
// reads the day's base need as an input and never touches the need models.
//
// Rules (plan #8): stops in time order, work a stop on work days (home ->
// before-shift events -> work -> after-shift events -> home); `#home` /
// `#straight` (notes, or the /trips toggle, which wins) decide what happens
// after an event; otherwise go home between two stops when the gap is at least
// drive back + drive out + 1h; an event <= 15 min from home is its own round
// trip from home; an event at home is a home stop; overlapping events in
// different places are both counted; an all-day event with a location is the
// day's destination; a multi-day event is the outbound leg only.
import { DEPART_BUFFER_MIN } from './chargePlan.ts';
import type { LatLon } from './ics.ts';
import type { HomeTag } from './personalCalendar.ts';
import type { Leg } from './valhalla.ts';

export const ARRIVAL_FLOOR_PCT = 25;       // the plan's minimum on getting home, and the trip's
export const PARKED_PCT = 2;
export const TRIP_MARGIN = 1.1;
export const NEAR_HOME_SECONDS = 15 * 60;
export const GAP_EXTRA_MS = 3_600_000;
export const DEPART_SLACK_MIN_MS = 15 * 60_000;
export const DEPART_SLACK_FRACTION = 0.2;
export const ALL_DAY_START_HOUR = 8;

const MIN_MS = 60_000;

// Miles per 1% of battery by the day's forecast high (plan #8's table).
export function milesPerPct(highF: number | null | undefined): number {
  if (typeof highF !== 'number' || !Number.isFinite(highF)) return 1.95;
  if (highF > 90) return 2.63;
  if (highF >= 75) return 2.88;
  if (highF >= 60) return 2.80;
  if (highF >= 45) return 2.69;
  return 1.95;
}

export function metersBetween(a: LatLon, b: LatLon): number {
  const R = 6371000;
  const p1 = a.lat * Math.PI / 180, p2 = b.lat * Math.PI / 180;
  const dp = (b.lat - a.lat) * Math.PI / 180, dl = (b.lon - a.lon) * Math.PI / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export type OverlapChoice = 'skip' | 'going' | 'fix';
export const choiceKey = (uid: string, day: number) => `${uid}@${day}`;

export interface TripEvent {
  uid: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  multiDay: boolean;
  tag: HomeTag | null;
  point: LatLon | null;     // null = could not be placed
}

// route(a, b, atMs) -> miles and seconds (traffic included) or null.
export type RouteFn = (a: LatLon, b: LatLon, atMs: number) => Promise<Leg | null>;

export interface TripDayInput {
  day: number;
  localMs: (hour: number) => number;   // local wall time on `day`
  home: LatLon;
  homeRadiusM: number;
  shift: { startMs: number; endMs: number } | null;   // earliest start, latest end (the safe reading)
  work: LatLon | null;
  events: TripEvent[];
  choices: Record<string, OverlapChoice>;
  toggles: Record<string, HomeTag>;
  route: RouteFn;
}

export type StopKind = 'home' | 'work' | 'event';
export interface PlannedStop {
  kind: StopKind;
  uid?: string;
  miles: number;                    // the leg into this stop
  after: 'home' | 'straight' | 'end';   // what follows this stop
  rule: 'tag' | 'toggle' | 'gap' | 'near' | 'overlap' | 'last' | null;
}

export interface TripDay {
  day: number;
  isWork: boolean;
  needsWork: boolean;       // a shift day with no known work location
  stops: PlannedStop[];
  miles: number;            // all driving that day (outbound only when multi-day)
  extraMiles: number;       // work days: miles beyond the plain commute (never below 0)
  departMs: number | null;  // when the car must be ready (before the first drive from home)
  unplaced: string[];       // uids that could not be placed
  overlaps: string[];       // uids overlapping the shift with no skip / going choice yet
  multiDay: boolean;
  unroutable: boolean;      // a leg could not be routed: no plan from it
}

const slack = (s: number) => Math.max(DEPART_SLACK_MIN_MS, DEPART_SLACK_FRACTION * s * 1000);

interface Link { kind: StopKind; ev?: TripEvent; startMs: number; endMs: number; point: LatLon }

export async function planTripDay(inp: TripDayInput): Promise<TripDay | null> {
  const { day, home, route } = inp;
  const out: TripDay = {
    day, isWork: !!inp.shift, needsWork: !!inp.shift && !inp.work, stops: [], miles: 0, extraMiles: 0,
    departMs: null, unplaced: [], overlaps: [], multiDay: false, unroutable: false,
  };
  const atHome = (p: LatLon) => metersBetween(p, home) <= inp.homeRadiusM;
  const sh = inp.shift && inp.work ? inp.shift : null;
  const work = inp.work;
  const startOf = (e: TripEvent) => (e.allDay ? (sh ? sh.endMs : inp.localMs(ALL_DAY_START_HOUR)) : e.startMs);
  const endOf = (e: TripEvent) => (e.allDay ? startOf(e) : Math.max(e.endMs, e.startMs));
  const tagOf = (e: TripEvent): HomeTag | null => inp.toggles[choiceKey(e.uid, day)] ?? e.tag;

  const live: TripEvent[] = [];
  for (const e of inp.events) {
    if (inp.choices[choiceKey(e.uid, day)] === 'skip') continue;
    if (!e.point) { out.unplaced.push(e.uid); continue; }
    live.push(e);
  }
  live.sort((a, b) => startOf(a) - startOf(b));

  let fail = false;
  const go = async (a: LatLon, b: LatLon, atMs: number): Promise<Leg> => {
    if (metersBetween(a, b) < 50) return { miles: 0, seconds: 0 };
    const l = await route(a, b, atMs);
    if (!l) { fail = true; return { miles: 0, seconds: 0 }; }
    return l;
  };
  const homeDeparts: number[] = [];
  let totalMiles = 0;
  // A drive that leaves home: the car has to be ready before it.
  const fromHome = async (to: LatLon, arriveMs: number): Promise<Leg> => {
    const l = await go(home, to, arriveMs - 20 * MIN_MS);
    if (l.seconds > 0) homeDeparts.push(arriveMs - l.seconds * 1000 - slack(l.seconds));
    return l;
  };

  // Work days: an event overlapping the shift is a round trip from work.
  if (sh && work) {
    for (const e of [...live]) {
      if (e.allDay || e.multiDay) continue;
      if (!(e.startMs < sh.endMs && endOf(e) > sh.startMs)) continue;
      live.splice(live.indexOf(e), 1);
      if (inp.choices[choiceKey(e.uid, day)] !== 'going') out.overlaps.push(e.uid);
      const a = await go(work, e.point!, e.startMs - 20 * MIN_MS);
      const b = await go(e.point!, work, endOf(e));
      totalMiles += a.miles + b.miles;
      out.stops.push({ kind: 'event', uid: e.uid, miles: a.miles, after: 'straight', rule: 'overlap' });
    }
  }

  // An event <= 15 min from home (not tagged #straight) is its own round trip from home.
  const rest: TripEvent[] = [];
  for (const e of live) {
    if (!e.multiDay && tagOf(e) !== 'straight' && !atHome(e.point!)) {
      const probe = await go(home, e.point!, startOf(e) - 20 * MIN_MS);
      if (probe.seconds > 0 && probe.seconds <= NEAR_HOME_SECONDS) {
        const there = await fromHome(e.point!, startOf(e));
        const back = await go(e.point!, home, endOf(e));
        totalMiles += there.miles + back.miles;
        out.stops.push({ kind: 'event', uid: e.uid, miles: there.miles, after: 'home', rule: 'near' });
        continue;
      }
    }
    rest.push(e);
  }

  const chain: Link[] = rest.map((e) => ({ kind: 'event', ev: e, startMs: startOf(e), endMs: endOf(e), point: e.point! }));
  if (sh && work) chain.push({ kind: 'work', startMs: sh.startMs, endMs: sh.endMs, point: work });
  chain.sort((a, b) => a.startMs - b.startMs);

  let pos: LatLon = home;
  for (let i = 0; i < chain.length; i++) {
    const s = chain[i];
    const e = s.ev;
    const into = pos === home ? await fromHome(s.point, s.startMs) : await go(pos, s.point, s.startMs - 20 * MIN_MS);
    totalMiles += into.miles;
    const homeStop = !!e && atHome(s.point);
    pos = homeStop ? home : s.point;
    const stop: PlannedStop = { kind: homeStop ? 'home' : s.kind, ...(e ? { uid: e.uid } : {}), miles: into.miles, after: 'end', rule: null };
    out.stops.push(stop);
    if (e?.multiDay) { out.multiDay = true; stop.rule = 'last'; break; }   // outbound only
    const next = chain[i + 1];
    if (pos === home) { if (next) stop.after = 'home'; continue; }
    if (!next) {
      totalMiles += (await go(pos, home, s.endMs)).miles;
      pos = home; stop.after = 'home'; stop.rule = 'last';
      continue;
    }
    const tag = e ? tagOf(e) : null;
    let goHome: boolean;
    if (tag) {
      goHome = tag === 'home';
      stop.rule = inp.toggles[choiceKey(e!.uid, day)] ? 'toggle' : 'tag';
    } else {
      const back = await go(pos, home, s.endMs);
      const outL = await go(home, next.point, next.startMs - 20 * MIN_MS);
      goHome = next.startMs - s.endMs >= (back.seconds + outL.seconds) * 1000 + GAP_EXTRA_MS;
      stop.rule = 'gap';
    }
    stop.after = goHome ? 'home' : 'straight';
    if (goHome) { totalMiles += (await go(pos, home, s.endMs)).miles; pos = home; }
  }

  // Work days: what the day's route adds to the plain commute.
  let commuteMiles = 0;
  if (sh && work) {
    commuteMiles = (await go(home, work, sh.startMs - 20 * MIN_MS)).miles + (await go(work, home, sh.endMs)).miles;
    homeDeparts.push(sh.startMs - DEPART_BUFFER_MIN * MIN_MS);
  }
  if (!out.stops.length && !out.unplaced.length) return null;
  out.unroutable = fail;
  out.miles = totalMiles;
  out.extraMiles = sh && work ? Math.max(0, totalMiles - commuteMiles) : 0;
  out.departMs = homeDeparts.length ? Math.min(...homeDeparts) : null;
  return out;
}

export interface Adjusted {
  tripPct: number;          // route miles / (miles per 1%) + parked, before the margin (work days: the extra miles only)
  needPct: number;          // the day's need after the trip
  targetPct: number;        // "N% by departure"
  raise: boolean;           // the trip asks for more than the normal plan
}

// The trip layer over a day's base need. Days off: need = max(normal, trip);
// work days: base + (route with events - plain commute), raise only.
export function adjustForTrip(p: { isWork: boolean; baseNeedPct: number; miles: number; extraMiles: number; highF: number | null }): Adjusted {
  const mpp = milesPerPct(p.highF);
  const base = Math.max(0, p.baseNeedPct);
  if (p.isWork) {
    const delta = Math.round(TRIP_MARGIN * (p.extraMiles / mpp));
    const need = base + delta;
    return { tripPct: p.extraMiles / mpp, needPct: need, targetPct: Math.min(100, ARRIVAL_FLOOR_PCT + need), raise: delta > 0 };
  }
  const tripPct = p.miles > 0 ? p.miles / mpp + PARKED_PCT : 0;
  const tripNeed = Math.round(TRIP_MARGIN * tripPct);
  return { tripPct, needPct: Math.max(base, tripNeed), targetPct: Math.min(100, ARRIVAL_FLOOR_PCT + tripNeed), raise: tripNeed > base };
}

// Days covered by a multi-day trip after its first (nothing is planned while away).
export function awayDays(events: { day: number; startMs: number; endMs: number; multiDay: boolean }[], dayOf: (ms: number) => number): Set<number> {
  const s = new Set<number>();
  for (const e of events) {
    if (!e.multiDay) continue;
    for (let d = e.day + 1; d <= dayOf(Math.max(e.startMs, e.endMs - 1)); d++) s.add(d);
  }
  return s;
}
