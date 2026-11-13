// Overnight charge planning from charge-history.jsonl sessions.
//
// Chosen by backtest (Feb-Oct 2026 history, 2026-11-07):
//
//  - Daily need = EWMA (7-day half-life) of daily use, where each session's
//    kWh is spread evenly over the days since that car's previous session
//    (at most MAX_SPREAD_DAYS). Charging every 2-3 days otherwise looks like
//    big days and zero days. Against the true use of the following week it
//    is as accurate as the old 6-month average (MAE 5.3 vs 5.2 kWh/day for
//    the Rivian) but follows a change in driving within days instead of
//    months.
//  - No average keeps the car topped up by itself: a day above average
//    leaves a shortfall that average-sized nights never repay (56-68% of
//    simulated mornings ended >10% of the pack short). So tonight's plan adds
//    a catch-up from the live gap below the charge limit:
//        tonight = need + max(0, gap - need) / CATCH_UP_NIGHTS
//    With 2 nights that cut short mornings to ~1% at an average of 13.4A
//    (p90 18A, max 24A) for the Rivian.
//  - Work days (shift calendar, shiftCalendar.ts) only ever raise the need:
//        planned = max(EWMA, recent kWh/day for tomorrow's kind of day)
//    Work/off rates come from a least-squares fit of each session's kWh on
//    the work and off days it covers, weighted with a 30-day half-life.
//    Since Sep 2026 that cut Rivian nights >5 kWh short from 11% to 5%, for
//    ~1.5 kWh/night more on average. Using the rates both ways (also cutting
//    before off days) tied the EWMA on error and left more short nights.
//  - Arrival floor, per vehicle (config.ts ArrivalFloorConfig; the Rivian's
//    is 25% after a day 1.1x the planned size, Penn 2026-11-07): tonight is
//    at least enough to get home at the floor, the morning SoC capped at the
//    charge limit. It only binds from a low SoC or a low limit; a day much
//    bigger than that needs an override (chargeOverride.ts).
//
// Pure functions (relative .ts imports only), so node:test can load this file directly.
import {
  KW_PER_AMP, nightCostUsd, overKwOf, planNights,
  type PeakChoice, type PeakHorizonNight, type PeakNightIn, type PeakPlanInput,
} from './peakPlan.ts';

export const CHARGE_VOLTS = 240;
export const CHARGE_WINDOW_HOURS = 8;
export const CHARGE_WINDOW_END_HOUR = 8;   // EV rate window is 00:00-08:00
export const WORK_RATE_HALF_LIFE_DAYS = 30;
export const MIN_DAYS_PER_KIND = 5;
export const KWH_PER_AMP = (CHARGE_VOLTS * CHARGE_WINDOW_HOURS) / 1000; // 1.92 kWh per amp over 8h
export const EWMA_HALF_LIFE_DAYS = 7;
export const CATCH_UP_NIGHTS = 2;
export const MAX_SPREAD_DAYS = 7;
// A session that starts before 06:00 local is the previous evening's charge.
export const USE_DAY_SHIFT_HOURS = 6;
// Daily use comes from wall-side kWh, the SoC gap is pack-side. L2 charging
// loses ~10%, so the gap is scaled up to the wall energy that refills it.
export const CHARGE_EFFICIENCY = 0.9;

const DAY_MS = 86_400_000;

export interface PlanSession {
  startedAt: string;
  energyKwh: number;
}

// Local (process TZ) calendar day of the use a session replenishes, as a day
// number (days since 1970-01-01 of that local date). null if unparseable.
export function useDayNumber(startedAt: string): number | null {
  const t = Date.parse(startedAt);
  if (!Number.isFinite(t)) return null;
  return localDayNumber(t - USE_DAY_SHIFT_HOURS * 3_600_000);
}

// Local (process TZ) calendar date of ms, as days since 1970-01-01.
export function localDayNumber(ms: number): number {
  const d = new Date(ms);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

// The day the coming overnight charge is for: the 00:00-08:00 window that
// ends today serves today until 08:00, tonight's serves tomorrow after that.
export function nextUseDay(nowMs: number): number {
  return localDayNumber(nowMs + (24 - CHARGE_WINDOW_END_HOUR) * 3_600_000);
}

// Daily use series from the first session's day through the last session's
// day. Days after the last session aren't included: their use is only known
// once the car next charges (tonightPlan's live gap covers them).
export function dailyUseSeries(sessions: PlanSession[]): { firstDay: number; use: number[] } | null {
  const byDay = new Map<number, number>();
  for (const s of sessions) {
    const day = s ? useDayNumber(s.startedAt) : null;
    const kwh = s && typeof s.energyKwh === 'number' ? s.energyKwh : NaN;
    if (day === null || !Number.isFinite(kwh) || kwh < 0) continue;
    byDay.set(day, (byDay.get(day) ?? 0) + kwh);
  }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  if (!days.length) return null;
  const firstDay = days[0];
  const use = new Array<number>(days[days.length - 1] - firstDay + 1).fill(0);
  days.forEach((day, i) => {
    const lo = i === 0 ? day : Math.max(days[i - 1] + 1, day - (MAX_SPREAD_DAYS - 1));
    const span = day - lo + 1;
    const share = byDay.get(day)! / span;
    for (let d = lo; d <= day; d++) use[d - firstDay] += share;
  });
  return { firstDay, use };
}

// null until there are at least two use-days (the first session's day is
// a lump with nothing before it to spread over, so it is skipped).
export function ewmaDailyKwh(sessions: PlanSession[], halfLifeDays = EWMA_HALF_LIFE_DAYS): number | null {
  const series = dailyUseSeries(sessions);
  if (!series || series.use.length < 2) return null;
  const alpha = 1 - 0.5 ** (1 / halfLifeDays);
  let m = series.use[1];
  for (let i = 2; i < series.use.length; i++) m = alpha * series.use[i] + (1 - alpha) * m;
  return m;
}

export interface WorkOffRates {
  workKwh: number;   // kWh/day on work days
  offKwh: number;    // kWh/day on off days
}

// Weighted least squares: session kWh ~ work * (work days covered) + off *
// (off days covered), spans as in dailyUseSeries (the first session, with
// nothing before it, is skipped). null without MIN_DAYS_PER_KIND of each, or
// when a rate comes out non-positive.
export function workOffRates(
  sessions: PlanSession[], workDays: Set<number>, nowDay: number, halfLifeDays = WORK_RATE_HALF_LIFE_DAYS,
): WorkOffRates | null {
  const byDay = new Map<number, number>();
  for (const s of sessions) {
    const day = s ? useDayNumber(s.startedAt) : null;
    const kwh = s && typeof s.energyKwh === 'number' ? s.energyKwh : NaN;
    if (day === null || !Number.isFinite(kwh) || kwh < 0) continue;
    byDay.set(day, (byDay.get(day) ?? 0) + kwh);
  }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  let sww = 0, swo = 0, soo = 0, swk = 0, sok = 0, nWork = 0, nOff = 0;
  for (let i = 1; i < days.length; i++) {
    const day = days[i];
    let w = 0, o = 0;
    for (let d = Math.max(days[i - 1] + 1, day - (MAX_SPREAD_DAYS - 1)); d <= day; d++) {
      if (workDays.has(d)) w++; else o++;
    }
    const k = byDay.get(day)!;
    const wt = 0.5 ** (Math.max(0, nowDay - day) / halfLifeDays);
    sww += wt * w * w; swo += wt * w * o; soo += wt * o * o; swk += wt * w * k; sok += wt * o * k;
    nWork += w; nOff += o;
  }
  const det = sww * soo - swo * swo;
  if (nWork < MIN_DAYS_PER_KIND || nOff < MIN_DAYS_PER_KIND || !(det > 0)) return null;
  const workKwh = (swk * soo - sok * swo) / det;
  const offKwh = (sok * sww - swk * swo) / det;
  return workKwh > 0 && offKwh > 0 ? { workKwh, offKwh } : null;
}

export interface NeedEstimate {
  ewmaKwh: number;
  rates: WorkOffRates | null;
  nextDayWork: boolean | null;   // null without a calendar
  plannedKwh: number;            // what tonight's plan uses
}

// null until ewmaDailyKwh has enough history. workDays null = no calendar.
export function needEstimate(sessions: PlanSession[], workDays: Set<number> | null, nowMs: number): NeedEstimate | null {
  const ewmaKwh = ewmaDailyKwh(sessions);
  if (ewmaKwh === null) return null;
  if (!workDays) return { ewmaKwh, rates: null, nextDayWork: null, plannedKwh: ewmaKwh };
  const rates = workOffRates(sessions, workDays, localDayNumber(nowMs));
  const nextDayWork = workDays.has(nextUseDay(nowMs));
  const plannedKwh = rates ? Math.max(ewmaKwh, nextDayWork ? rates.workKwh : rates.offKwh) : ewmaKwh;
  return { ewmaKwh, rates, nextDayWork, plannedKwh };
}

// Amps (2A steps, rounded up) that add `kwh` over `hours` (default the 8h
// window), clamped. Zero hours can't charge anything: maxAmps.
export function ampsFor(kwh: number, minAmps = 0, maxAmps = 48, hours = CHARGE_WINDOW_HOURS): number {
  if (!(hours > 0)) return maxAmps;
  const raw = Math.ceil(Math.max(0, kwh) / ((CHARGE_VOLTS / 1000) * hours) / 2) * 2;
  return Math.min(maxAmps, Math.max(minAmps, raw));
}

export interface TonightInput {
  dailyKwh: number;
  socPct: number | null | undefined;
  limitPct: number | null | undefined;
  packKwh: number;
  minAmps: number;
  maxAmps: number;
  arrivalFloorPct?: number | null;   // get home after the next day at no less than this
  arrivalDriveMargin?: number;       // ...after a day this many times dailyKwh (default 1)
}

// A vehicle's floor settings from config, with bad values dropped: floor
// 0..100 or none, margin >= 1.
export function arrivalFloorOf(v: { arrivalFloorPct?: unknown; arrivalDriveMargin?: unknown } | null | undefined):
  { arrivalFloorPct: number | null; arrivalDriveMargin: number } {
  const f = v?.arrivalFloorPct;
  const m = v?.arrivalDriveMargin;
  return {
    arrivalFloorPct: typeof f === 'number' && Number.isFinite(f) && f > 0 && f <= 100 ? f : null,
    arrivalDriveMargin: typeof m === 'number' && Number.isFinite(m) && m >= 1 ? m : 1,
  };
}

export interface TonightPlan {
  gapKwh: number | null;   // wall kWh to refill the gap below the charge limit; null if SoC/limit unknown
  // wall kWh that gets home at arrivalFloorPct after a day of
  // arrivalDriveMargin x dailyKwh (morning
  // SoC capped at the limit); null if SoC/limit unknown or no floor given
  floorKwh: number | null;
  tonightKwh: number;
  tonightAmps: number;
}

export function tonightPlan(p: TonightInput): TonightPlan {
  const soc = p.socPct;
  const limit = p.limitPct;
  const known = typeof soc === 'number' && typeof limit === 'number' && Number.isFinite(soc) && Number.isFinite(limit)
    && soc > 0 && limit > 0;
  const gapKwh = known ? Math.max(0, ((limit! - soc!) / 100) * p.packKwh) / CHARGE_EFFICIENCY : null;
  const catchUpKwh = p.dailyKwh + (gapKwh === null ? 0 : Math.max(0, gapKwh - p.dailyKwh) / CATCH_UP_NIGHTS);
  let floorKwh: number | null = null;
  if (known && typeof p.arrivalFloorPct === 'number' && Number.isFinite(p.arrivalFloorPct)) {
    const margin = typeof p.arrivalDriveMargin === 'number' && Number.isFinite(p.arrivalDriveMargin) ? Math.max(1, p.arrivalDriveMargin) : 1;
    const dayPct = (Math.max(0, p.dailyKwh) * margin * CHARGE_EFFICIENCY / p.packKwh) * 100;
    const morningPct = Math.min(limit!, p.arrivalFloorPct + dayPct);
    floorKwh = Math.max(0, ((morningPct - soc!) / 100) * p.packKwh) / CHARGE_EFFICIENCY;
  }
  const tonightKwh = Math.max(catchUpKwh, floorKwh ?? 0);
  return { gapKwh, floorKwh, tonightKwh, tonightAmps: ampsFor(tonightKwh, p.minAmps, p.maxAmps) };
}

// ---------------------------------------------------------------------------
// Shift-aware night plan, in battery % (EV charge plan #1/#2, Penn 2026-11-12).
//
// The car's schedule is always 00:00-08:00; the plan only *counts* the hours
// Penn can really charge in. The Rivian plan works in % and turns it into wall
// kWh with kwhPerPct (measured at the charger, so it already holds pack size
// and charging losses; the Tesla keeps tonightPlan above).
//
//  - With an arrival floor (the Rivian, 25%), the target is what tomorrow's
//    forecast driving needs: floor + day x margin, so the car gets home at
//    the floor (Penn 2026-11-13: "it should look at what tomorrow's forecast
//    driving is and plan to get us to that, using minimum amps it can").
//    The amps are the lowest that reach it. The car runs its schedule for the
//    whole window at those amps and stops at its own limit (70%), which is
//    the upper buffer ("use the car as the limiter"); so a night already past
//    the target still gets the minimum amps, and endPct is where the morning
//    really lands. The heat top-up cap doesn't apply here. This replaced the
//    put-back on work nights and the catch-up on off nights (2026-11-07).
//    Days off get the same floor and margin; their use is the average of
//    past days off minus outliers or the calendar, whichever is more
//    (needModels.offDayNeed + tripPlan.adjustForTrip; Penn: "or our
//    calendar, whichever is more ... plus the same buffers as a work day").
//  - Without a floor: work nights put back the day x margin (capped by the
//    heat top-up), off nights the day plus half of the rest of the gap.
//  - Never above the limit; a reach target above it sets raiseLimitTo.
//  - Short-night buffer: when the next night has < 8 planned hours, tonight
//    adds next need x hours lost / 8, if the limit has room.
// A peak cap (EV charge plan #9b) belongs in ampsForNeed, the one place the
// needed amps are computed.
// ---------------------------------------------------------------------------

export const HOME_BUFFER_MIN = 20;       // home this long after a shift ends
export const DEPART_BUFFER_MIN = 60;     // leaves this long before a shift starts
export const HEAT_FORECAST_HIGH_F = 90;  // Rev 11: at or above this tomorrow...
export const HEAT_TOPUP_LIMIT_PCT = 60;  // ...work nights stop topping up here
const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

export interface Shift {
  day: number;       // local start date (days since 1970-01-01)
  startMs: number;
  endMs: number;
  uid?: string;
}

// Local wall-clock time on a day number, as epoch ms.
export function dayTimeMs(day: number, hour = 0, minute = 0): number {
  const d = new Date(day * DAY_MS);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute).getTime();
}

export interface WindowReading {
  startMs: number;
  endMs: number;
  hours: number;
}

export interface NightWindow extends WindowReading {
  conflict: boolean;           // shifts on the day (or the day before) disagree
  readings: WindowReading[];   // one per reading of the calendar; the safe one is the top-level window
}

function distinctShifts(list: Shift[]): Shift[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    const k = `${s.startMs}|${s.endMs}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// The hours counted for the charge that serves `day` (the 00:00-08:00 window
// on the morning of `day`): from the previous day's shift end + 20 min (never
// before 00:00) to the day's shift start - 1h (never after 08:00). Several
// shifts that disagree set `conflict` and give one reading each; the
// top-level window is the safe one, the fewest hours.
export function nightWindow(day: number, shifts: Shift[]): NightWindow {
  const midnight = dayTimeMs(day, 0);
  const eight = dayTimeMs(day, 8);
  const today = distinctShifts(shifts.filter((s) => s.day === day));
  const prev = distinctShifts(shifts.filter((s) => s.day === day - 1 && s.endMs + HOME_BUFFER_MIN * MIN_MS > midnight));
  const starts = prev.length ? prev.map((s) => s.endMs + HOME_BUFFER_MIN * MIN_MS) : [midnight];
  const ends = today.length ? today.map((s) => s.startMs - DEPART_BUFFER_MIN * MIN_MS) : [eight];
  const readings: WindowReading[] = [];
  const seen = new Set<string>();
  for (const a of starts) {
    for (const b of ends) {
      const startMs = Math.max(midnight, a);
      const endMs = Math.min(eight, b);
      const hours = Math.max(0, Math.min(CHARGE_WINDOW_HOURS, (endMs - startMs) / HOUR_MS));
      const k = `${startMs}|${endMs}`;
      if (seen.has(k)) continue;
      seen.add(k);
      readings.push({ startMs, endMs, hours });
    }
  }
  const safe = readings.reduce((best, r) => (r.hours < best.hours ? r : best), readings[0]);
  return { ...safe, conflict: today.length > 1 || prev.length > 1, readings };
}

// The one place the needed amps come from (see the note above).
export function ampsForNeed(kwh: number, hours: number, minAmps: number, maxAmps: number): number {
  return ampsFor(kwh, minAmps, maxAmps, hours);
}

export interface NightNext {
  hours: number;     // next night's planned hours
  usePct: number;    // next day's expected use, % of the battery
  isWork: boolean;
}

export interface NightPlanInput {
  isWork: boolean;
  socPct: number | null | undefined;     // SoC the plan starts from
  limitPct: number | null | undefined;
  usePct: number;                        // the day's expected use in %, no margin
  margin?: number;                       // x use for put-back and reach (default 1)
  floorPct?: number | null;              // arrival floor; null/absent = none
  topUpLimitPct?: number | null;         // work nights stop topping up here (heat cap); plans without a floor only
  windowHours: number;
  next?: NightNext | null;
  kwhPerPct: number;
  minAmps: number;
  maxAmps: number;
}

export interface NightPlan {
  isWork: boolean;
  windowHours: number;
  nextWindowHours: number | null;
  needPct: number;            // own need, % gained
  bufferPct: number;          // short-night buffer added
  totalPct: number;
  targetPct: number | null;   // SoC the morning should reach (soc + totalPct)
  reachPct: number | null;    // arrival floor + the day's use x margin (what the morning needs); null without a floor
  endPct: number | null;      // SoC the car really ends at: the whole window at `amps`, stopped by the limit
  gapPct: number | null;      // limit - soc
  kwh: number;                // totalPct x kwhPerPct, wall kWh
  amps: number | null;        // null when the window has no hours
  raiseLimitTo: number | null;
  shortfallPct: number;       // what can't be put in at maxAmps (tonight + the short night)
  shortfall: boolean;
  peak?: PeakView | null;     // Rev 18: set when the demand-aware planner chose tonight's amps
}

// What the demand-aware planner (lib/peakPlan.ts) did with tonight.
export interface PeakView {
  charge: boolean;                 // tonight should charge (false: no need to plug in; the schedule still holds minAmps)
  plannedAmps: Array<number | null>;   // tonight and the next nights, null = no charge
  morningPct: number[];
  aimKw: number | null;            // forecast day peak outside 00:00-08:00 x margin: the line tonight aims to stay under
  houseKw: number | null;          // the house's own night load
  headroomKw: number | null;       // room under the line (middle of the spread)
  evKw: number;                    // tonight's charger draw
  overKw: number;                  // how far tonight goes over the line, 0 = under it
  costUsd: number;                 // tonight's expected demand charge
  horizonUsd: number;              // the planned nights plus the charge still owed after them
}

const known = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

function needFor(p: {
  isWork: boolean; soc: number | null; limit: number | null; usePct: number; margin: number;
  floorPct: number | null; topUp: number | null;
}): { needPct: number; reachTargetPct: number | null; gapPct: number | null } {
  const day = Math.max(0, p.usePct);
  const reach = p.floorPct === null ? null : p.floorPct + day * p.margin;
  if (p.soc === null || p.limit === null) {
    return { needPct: p.isWork || reach !== null ? day * p.margin : day, reachTargetPct: reach, gapPct: null };
  }
  const gap = Math.max(0, p.limit - p.soc);
  let target: number;
  if (reach !== null) {
    target = Math.min(reach, p.limit);   // reach only; a reach above the limit sets raiseLimitTo
  } else if (p.isWork) {
    const cap = p.topUp === null ? p.limit : Math.min(p.limit, p.topUp);
    const putBack = Math.min(p.soc + day * p.margin, cap);
    target = putBack;
  } else {
    const catchUp = day + Math.max(0, gap - day) / CATCH_UP_NIGHTS;
    target = Math.min(p.soc + catchUp, Math.max(p.limit, p.soc));
  }
  return { needPct: Math.max(0, target - p.soc), reachTargetPct: reach, gapPct: gap };
}

export function nightPlan(p: NightPlanInput): NightPlan {
  const soc = known(p.socPct) ? p.socPct : null;
  const limit = known(p.limitPct) ? p.limitPct : null;
  const margin = typeof p.margin === 'number' && p.margin >= 1 ? p.margin : 1;
  const floorPct = typeof p.floorPct === 'number' && p.floorPct > 0 ? p.floorPct : null;
  const topUp = p.isWork && typeof p.topUpLimitPct === 'number' ? p.topUpLimitPct : null;
  const own = needFor({ isWork: p.isWork, soc, limit, usePct: p.usePct, margin, floorPct, topUp });

  const raiseLimitTo = own.reachTargetPct !== null && limit !== null && own.reachTargetPct > limit
    ? Math.min(100, Math.ceil(own.reachTargetPct)) : null;

  const hours = Math.max(0, p.windowHours);
  const maxPct = (h: number) => (p.maxAmps * (CHARGE_VOLTS / 1000) * h) / p.kwhPerPct;
  const tonightMaxPct = maxPct(hours);

  // Short-night buffer: the next night's need, from the SoC left after tonight
  // and the day between, in proportion to the hours it loses.
  let bufferPct = 0, nextShort = 0;
  if (p.next) {
    const after = soc !== null && limit !== null
      ? Math.min(soc + own.needPct, Math.max(limit, soc)) - Math.max(0, p.usePct) * margin : null;
    const nextNeed = needFor({
      isWork: p.next.isWork, soc: after === null ? null : Math.max(0, after), limit, usePct: p.next.usePct, margin, floorPct, topUp,
    }).needPct;
    const lost = Math.max(0, CHARGE_WINDOW_HOURS - p.next.hours);
    if (lost > 0 && soc !== null && limit !== null) {
      const room = Math.max(0, limit - (soc + own.needPct));
      const canCharge = Math.max(0, tonightMaxPct - own.needPct);
      bufferPct = Math.min((nextNeed * lost) / CHARGE_WINDOW_HOURS, room, canCharge);
    }
    nextShort = Math.max(0, nextNeed - maxPct(Math.max(0, p.next.hours)) - bufferPct);
  }

  const totalPct = own.needPct + bufferPct;
  const kwh = totalPct * p.kwhPerPct;
  const amps = hours > 0 ? ampsForNeed(kwh, hours, p.minAmps, p.maxAmps) : null;
  const shortfallPct = Math.max(0, own.needPct - tonightMaxPct) + nextShort;
  return {
    isWork: p.isWork,
    windowHours: hours,
    nextWindowHours: p.next ? p.next.hours : null,
    needPct: own.needPct,
    bufferPct,
    totalPct,
    targetPct: soc === null ? null : soc + totalPct,
    reachPct: own.reachTargetPct,
    endPct: soc === null || amps === null ? null
      : Math.max(soc, Math.min(limit ?? 100, soc + (amps * (CHARGE_VOLTS / 1000) * hours) / p.kwhPerPct)),
    gapPct: own.gapPct,
    kwh,
    amps,
    raiseLimitTo,
    shortfallPct,
    shortfall: shortfallPct > 1e-9,
  };
}

// Work-day or off-day expected kWh from a NeedEstimate (raise-only vs the EWMA).
export function plannedFor(est: Pick<NeedEstimate, 'ewmaKwh' | 'rates'>, isWork: boolean): number {
  return est.rates ? Math.max(est.ewmaKwh, isWork ? est.rates.workKwh : est.rates.offKwh) : est.ewmaKwh;
}

// Rev 11: work nights top up only to 60% when tomorrow's forecast high is 90F+.
export function topUpLimitFor(forecastHighF: number | null | undefined): number | null {
  return typeof forecastHighF === 'number' && forecastHighF >= HEAT_FORECAST_HIGH_F ? HEAT_TOPUP_LIMIT_PCT : null;
}

export interface TonightInputs {
  day: number;                   // the day the coming charge serves
  shifts: Shift[];
  workDays: Set<number> | null;  // null = no calendar: every day plans as an off day
  usePctWork: number;            // expected use per kind of day, in %
  usePctOff: number;
  // Days with a typed need: the day's total driving in %. It only raises the work/off figure for
  // that day (max), for tonight and for the next night's short-night buffer.
  usePctByDay?: Record<number, number> | null;
  socPct: number | null | undefined;
  limitPct: number | null | undefined;
  margin?: number;
  floorPct?: number | null;
  topUpLimitPct?: number | null;
  kwhPerPct: number;
  minAmps: number;
  maxAmps: number;
  // Rev 18: room under the day peak for tonight and the next nights (lib/peakForecast.ts). Absent or
  // null: the plain lowest-amps plan.
  peak?: PeakNightIn[] | null;
}

export interface TonightResult {
  day: number;
  isWork: boolean;
  window: NightWindow;
  nextWindow: NightWindow;
  conflict: boolean;
  plan: NightPlan;        // tonight's: the reading that needs the most amps
  readings: NightPlan[];  // one per reading of the calendar
  // The demand planner's inputs without the SoC, so the plug-in decision can rerun it from the
  // car's real SoC. null when it didn't run (off, no limit or no floor).
  peakInput: Omit<PeakPlanInput, 'socPct'> | null;
}

// nightPlan for tonight, run once per reading of a conflicting calendar
// (window and next night); tonight uses whichever needs the most charge.
export function planTonight(p: TonightInputs): TonightResult {
  const isWork = !!p.workDays?.has(p.day);
  const nextIsWork = !!p.workDays?.has(p.day + 1);
  const window = nightWindow(p.day, p.shifts);
  const nextWindow = nightWindow(p.day + 1, p.shifts);
  const useOn = (day: number, work: boolean) => Math.max(work ? p.usePctWork : p.usePctOff, p.usePctByDay?.[day] ?? 0);
  const readings: NightPlan[] = [];
  for (const w of window.readings) {
    for (const n of nextWindow.readings) {
      readings.push(nightPlan({
        isWork, socPct: p.socPct, limitPct: p.limitPct, usePct: useOn(p.day, isWork),
        margin: p.margin, floorPct: p.floorPct, topUpLimitPct: p.topUpLimitPct, windowHours: w.hours,
        next: { hours: n.hours, usePct: useOn(p.day + 1, nextIsWork), isWork: nextIsWork },
        kwhPerPct: p.kwhPerPct, minAmps: p.minAmps, maxAmps: p.maxAmps,
      }));
    }
  }
  const rank = (x: NightPlan) => (x.amps === null ? -1 : x.amps);
  let plan = readings.reduce((best, r) => (rank(r) > rank(best) || (rank(r) === rank(best) && r.totalPct > best.totalPct) ? r : best), readings[0]);

  // Rev 18: the demand-aware amps over tonight and the next two nights (safe windows).
  const limit = known(p.limitPct) ? p.limitPct : null;
  const floor = typeof p.floorPct === 'number' && p.floorPct > 0 ? p.floorPct : null;
  let peakInput: Omit<PeakPlanInput, 'socPct'> | null = null;
  if (p.peak && limit !== null && floor !== null) {
    const hours = [window.hours, nextWindow.hours, nightWindow(p.day + 2, p.shifts).hours];
    const nights: PeakHorizonNight[] = hours.map((h, k) => ({
      ...(p.peak![k] ?? { aimKw: null, houseKw: null, headroomKw: [] }),
      hours: h,
      usePct: useOn(p.day + k, !!p.workDays?.has(p.day + k)),
    }));
    const margin = typeof p.margin === 'number' && p.margin >= 1 ? p.margin : 1;
    peakInput = { limitPct: limit, floorPct: floor, margin, kwhPerPct: p.kwhPerPct, nights, minAmps: p.minAmps, maxAmps: p.maxAmps };
    if (known(p.socPct)) plan = withPeak(plan, planNights({ ...peakInput, socPct: p.socPct }), nights[0], p.socPct, limit, p.kwhPerPct, p.minAmps, p.maxAmps);
  }
  return { day: p.day, isWork, window, nextWindow, conflict: window.conflict || nextWindow.conflict, plan, readings, peakInput };
}

// Tonight's plan with the demand planner's amps. It never goes below what tonight's own need
// takes; a night that needs no charge still holds the minimum on the schedule (a disabled
// schedule would charge at once) and says no need to plug in. The target becomes the lowest
// morning that keeps the next nights reachable (it replaces the short-night buffer).
export function withPeak(
  plan: NightPlan, c: PeakChoice, night: PeakHorizonNight, soc: number, limit: number,
  kwhPerPct: number, minAmps: number, maxAmps: number,
): NightPlan {
  const hours = plan.windowHours;
  if (!(hours > 0)) return plan;
  const ownAmps = plan.needPct > 1e-9 ? ampsForNeed(plan.needPct * kwhPerPct, hours, minAmps, maxAmps) : null;
  const pick = c.amps[0];
  const charge = pick !== null || ownAmps !== null;
  const amps = Math.max(pick ?? 0, ownAmps ?? 0, minAmps);
  const totalPct = Math.max(plan.needPct, c.requiredPct[0] - soc, 0);
  const room = night.headroomKw.length ? [...night.headroomKw].sort((a, b) => a - b)[Math.floor(night.headroomKw.length / 2)] : null;
  return {
    ...plan,
    bufferPct: Math.max(0, totalPct - plan.needPct),
    totalPct,
    targetPct: soc + totalPct,
    kwh: totalPct * kwhPerPct,
    amps,
    endPct: charge ? Math.max(soc, Math.min(limit, soc + (amps * (CHARGE_VOLTS / 1000) * hours) / kwhPerPct)) : soc,
    peak: {
      charge,
      plannedAmps: c.amps,
      morningPct: c.morningPct,
      aimKw: night.aimKw,
      houseKw: night.houseKw,
      headroomKw: room,
      evKw: charge ? amps * KW_PER_AMP : 0,
      overKw: charge ? overKwOf(amps, night.headroomKw) : 0,
      costUsd: charge ? nightCostUsd(amps, night.headroomKw) : 0,
      horizonUsd: c.totalUsd,
    },
  };
}

// #6b: Midknight-only history. Rows from before `since` (YYYY-MM-DD, local
// midnight) are the previous Rivian's. No/garbled `since` keeps everything.
export function historyStartMs(since: unknown): number | null {
  const m = typeof since === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(since) : null;
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : null;
}

export function sinceHistoryStart<T extends { startedAt: string }>(rows: T[], since: unknown): T[] {
  const from = historyStartMs(since);
  if (from === null) return rows;
  return rows.filter((r) => Date.parse(r.startedAt) >= from);
}
