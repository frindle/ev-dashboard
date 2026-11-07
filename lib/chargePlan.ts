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
//  - Arrival floor (Penn, 2026-11-07): tonight is at least enough that a day
//    ARRIVAL_DRIVE_MARGIN x the planned size still gets home at
//    ARRIVAL_FLOOR_PCT, capped at the charge limit. It only binds from a low
//    SoC or a low limit; a day much bigger than that needs an override
//    (chargeOverride.ts).
//
// Pure functions, no imports, so node:test can load this file directly.

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
export const ARRIVAL_FLOOR_PCT = 25;
export const ARRIVAL_DRIVE_MARGIN = 1.1;   // floor plans for 10% more driving than predicted

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

// Amps (2A steps, rounded up) that add `kwh` in the 8h window, clamped.
export function ampsFor(kwh: number, minAmps = 0, maxAmps = 48): number {
  const raw = Math.ceil(Math.max(0, kwh) / KWH_PER_AMP / 2) * 2;
  return Math.min(maxAmps, Math.max(minAmps, raw));
}

export interface TonightInput {
  dailyKwh: number;
  socPct: number | null | undefined;
  limitPct: number | null | undefined;
  packKwh: number;
  minAmps: number;
  maxAmps: number;
  arrivalFloorPct?: number;   // get home after the next day at no less than this
}

export interface TonightPlan {
  gapKwh: number | null;   // wall kWh to refill the gap below the charge limit; null if SoC/limit unknown
  // wall kWh that gets home at arrivalFloorPct after a day of
  // ARRIVAL_DRIVE_MARGIN x dailyKwh (morning
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
    const dayPct = (Math.max(0, p.dailyKwh) * ARRIVAL_DRIVE_MARGIN * CHARGE_EFFICIENCY / p.packKwh) * 100;
    const morningPct = Math.min(limit!, p.arrivalFloorPct + dayPct);
    floorKwh = Math.max(0, ((morningPct - soc!) / 100) * p.packKwh) / CHARGE_EFFICIENCY;
  }
  const tonightKwh = Math.max(catchUpKwh, floorKwh ?? 0);
  return { gapKwh, floorKwh, tonightKwh, tonightAmps: ampsFor(tonightKwh, p.minAmps, p.maxAmps) };
}
