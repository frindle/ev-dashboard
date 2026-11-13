// What the dashboard writes to the Rivian's charging schedule. Pure
// (process-TZ local time), so node:test can load this file.
//
// Charging stays inside the EV rate window, midnight to 08:00 (Penn,
// 2026-11-07): the managed schedule is always forced to EV_WINDOW and only
// its amperage moves. During the window the daily plan is frozen (SoC rises
// as it charges, which would talk the plan down mid-session); only an
// override may raise the amps then.
//
// The dashboard writes ONE schedule covering all seven days (Penn
// 2026-11-12: "control all charging, not just some of the days"). Rivian
// rejects a schedule list whose entries share a weekday, disabled ones
// included (BAD_REQUEST_ERROR / INVALID_INPUT, seen live 2026-11-13 with the
// app's every-day + weekday + weekend trio; same fix as
// bretterer/home-assistant-rivian#308), so the list sent is always a single
// entry.
import type { RivianChargingSchedule } from './rivian.ts';
import type { ChargeWindow } from './chargeOverride.ts';
import { ampsForNeed, localDayNumber } from './chargePlan.ts';
import { KW_PER_AMP } from './peakPlan.ts';

export const EV_WINDOW: ChargeWindow = { startMin: 0, durationMin: 8 * 60 };

// A "hold" night (plug-in rule, Penn 2026-11-13): the same single enabled entry, one minute long,
// so the car has nothing to charge in. A disabled schedule would make it charge at once at 48A.
export const HOLD_DURATION_MIN = 1;

// The room quantile a no-need night must fit 8A under: ROOM_QUANTILES[1] = p30.
export const NO_NEED_ROOM_QUANTILE_INDEX = 1;

// 8A fits when the p30 room under the forecast day peak covers it. Unknown room ([]) = no.
export function noNeedFits(headroomKw: number[], minAmps: number): boolean {
  const room = headroomKw[NO_NEED_ROOM_QUANTILE_INDEX];
  return typeof room === 'number' && Number.isFinite(room) && minAmps * KW_PER_AMP <= room;
}

export const ALL_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

// The schedule the dashboard manages: the enabled one covering the most
// weekdays, else the first. -1 when there are none.
export function managedIndex(list: RivianChargingSchedule[]): number {
  let best = -1;
  list.forEach((s, i) => {
    if (best === -1) { best = i; return; }
    const b = list[best];
    const better = (s.enabled && !b.enabled) || (s.enabled === b.enabled && s.weekDays.length > b.weekDays.length)
      || (s.enabled === b.enabled && s.weekDays.length === b.weekDays.length && shapeOf(s) !== null && shapeOf(b) === null);
    if (better) best = i;
  });
  return best;
}

export type Shape = 'charge' | 'hold';

// The two shapes the dashboard writes: the 00:00-08:00 charge window, or the one-minute hold.
export function shapeOf(s: RivianChargingSchedule): Shape | null {
  if (!s.enabled || s.startTime !== EV_WINDOW.startMin || !ALL_DAYS.every((d) => s.weekDays.includes(d))) return null;
  if (s.duration === EV_WINDOW.durationMin) return 'charge';
  return s.duration === HOLD_DURATION_MIN ? 'hold' : null;
}

export function inWindowShape(s: RivianChargingSchedule): boolean {
  return shapeOf(s) !== null;
}

// The car is fully under dashboard control: the managed schedule is the
// all-days EV_WINDOW one and no other schedule is enabled.
export function listInShape(list: RivianChargingSchedule[]): boolean {
  const i = managedIndex(list);
  return i >= 0 && inWindowShape(list[i]) && list.every((s, j) => j === i || !s.enabled);
}

// The one-entry list to write so the car runs EV_WINDOW at `amps` every day (or, with `hold`,
// the one-minute hold at `amps`). null when it already does, or there is no schedule to take the
// home location from.
export function scheduleWithAmps(list: RivianChargingSchedule[], amps: number, hold = false): RivianChargingSchedule[] | null {
  const i = managedIndex(list);
  if (i < 0) return null;
  const cur = list[i];
  if (listInShape(list) && cur.amperage === amps && shapeOf(cur) === (hold ? 'hold' : 'charge')) return null;
  return [{
    weekDays: [...ALL_DAYS], startTime: EV_WINDOW.startMin, duration: hold ? HOLD_DURATION_MIN : EV_WINDOW.durationMin,
    location: cur.location, amperage: amps, enabled: true,
  }];
}

export interface AmpsDecision {
  amps: number | null;   // null: leave the car's schedule alone
  reason: string;
  hold?: true;           // write the one-minute hold at `amps` instead of the charge window
}

export function inEvWindow(nowMs: number): boolean {
  const d = new Date(nowMs);
  const min = d.getHours() * 60 + d.getMinutes();
  return min >= EV_WINDOW.startMin && min < EV_WINDOW.startMin + EV_WINDOW.durationMin;
}

export type Slot = 'forecast' | 'update';

const FORECAST_FROM_MIN = 8 * 60 + 15;
const FORECAST_UNTIL_MIN = 22 * 60 + 45;
const UPDATE_FROM_MIN = 23 * 60;
const UPDATE_UNTIL_MIN = 23 * 60 + 59;

// Local day number each slot last completed (written, or already up to date).
export interface SlotsDone {
  forecast?: number | null;
  update?: number | null;
}

// The daily plan is written in two slots (Penn 2026-11-12), not every run: a
// forecast from 08:15 (gives up at 22:45) and an update from 23:00 (gives up
// at 23:59). The 15-minute run interval is the retry. Returns the slot a run
// at nowMs belongs to, or null: between slots, past a give-up time, or the
// slot already done today.
export function writeSlot(nowMs: number, done: SlotsDone): Slot | null {
  const d = new Date(nowMs);
  const min = d.getHours() * 60 + d.getMinutes();
  const today = localDayNumber(nowMs);
  if (min >= FORECAST_FROM_MIN && min < FORECAST_UNTIL_MIN && done.forecast !== today) return 'forecast';
  if (min >= UPDATE_FROM_MIN && min < UPDATE_UNTIL_MIN && done.update !== today) return 'update';
  return null;
}

// Late-start replan. The car isn't charging by the planned start + 15 min and
// later starts inside the window: the amps are recomputed once for the hours
// left, from the SoC the plan was aiming at. Not charging by start + 30 min
// also asks for a push.
export interface LateStartInput {
  nowMs: number;
  windowStartMs: number;
  windowEndMs: number;
  charging: boolean;
  lateSeen: boolean;
  replanned: boolean;
  targetPct: number | null;
  socPct: number | null;
  kwhPerPct: number;
  minAmps: number;
  maxAmps: number;
}

export interface LateStartStep {
  lateSeen: boolean;
  replanAmps: number | null;
  notChargingPush: boolean;
}

export function lateStartStep(p: LateStartInput): LateStartStep {
  const none: LateStartStep = { lateSeen: p.lateSeen, replanAmps: null, notChargingPush: false };
  if (p.nowMs < p.windowStartMs + 15 * 60_000 || p.nowMs >= p.windowEndMs) return none;
  if (!p.charging) return { ...none, lateSeen: true, notChargingPush: p.nowMs >= p.windowStartMs + 30 * 60_000 };
  if (!p.lateSeen || p.replanned || p.targetPct === null || p.socPct === null) return none;
  const hoursLeft = (p.windowEndMs - p.nowMs) / 3_600_000;
  const remainingPct = Math.max(0, p.targetPct - p.socPct);
  return { ...none, replanAmps: ampsForNeed(remainingPct * p.kwhPerPct, hoursLeft, p.minAmps, p.maxAmps) };
}

export function decideAmps(p: {
  nowMs: number;
  current: RivianChargingSchedule | null;
  dailyAmps: number | null;
  overrideAmps: number | null;
  slot: Slot | null;
  replanAmps?: number | null;      // late-start replan: may raise inside the window
  fixRaiseAmps?: number | null;    // a shift conflict fixed after 23:00: raise, never lower
  inShape?: boolean;               // the whole list is in shape (listInShape); default: current alone
  // No-need night (plugDecision.needed === false, no override): the write slots put the night
  // at minAmps, as the 8A charge when it fits under the forecast peak, else as the hold.
  noNeed?: { fits: boolean; minAmps: number };
}): AmpsDecision {
  const { current, dailyAmps, overrideAmps } = p;
  if (!current) return { amps: null, reason: 'no charging schedule on the car' };
  const kind = shapeOf(current);
  const isHold = kind === 'hold';
  // A hold counts as out of shape for the charge write: any raise rewrites it as the window.
  const shaped = (p.inShape ?? inWindowShape(current)) && !isHold;
  const raises: Array<[number | null | undefined, string]> = [
    [overrideAmps, 'override, raised mid-window'],
    [p.replanAmps, 'late-start replan'],
    [p.fixRaiseAmps, 'shift conflict fixed, raised'],
  ];
  if (inEvWindow(p.nowMs)) {
    // Inside the window charge -> hold is never written; hold -> charge only as a raise.
    let best: AmpsDecision = { amps: null, reason: isHold ? 'hold night, window running' : 'charge window running' };
    if (isHold && (p.inShape ?? true)) {
      for (const [a, reason] of raises) {
        if (typeof a === 'number' && a > 0 && a > (best.amps ?? 0)) best = { amps: a, reason: `${reason} (from hold)` };
      }
    } else if (shaped) {
      for (const [a, reason] of raises) {
        if (typeof a === 'number' && a > current.amperage && a > (best.amps ?? 0)) best = { amps: a, reason };
      }
    }
    return best;
  }
  if (p.slot !== null && p.noNeed && !(typeof overrideAmps === 'number' && overrideAmps > 0)) {
    const hold = !p.noNeed.fits;
    const want = p.noNeed.minAmps;
    const same = (p.inShape ?? inWindowShape(current)) && kind === (hold ? 'hold' : 'charge') && current.amperage === want;
    if (same) return { amps: null, reason: 'up to date' };
    return hold ? { amps: want, hold: true, reason: `${p.slot} slot, no-need night, hold` }
      : { amps: want, reason: `${p.slot} slot, no-need night, ${want}A fits under the forecast peak` };
  }
  if (p.slot !== null) {
    const desired = Math.max(dailyAmps ?? 0, overrideAmps ?? 0);
    if (!(desired > 0)) return { amps: null, reason: 'no plan yet' };
    const source = overrideAmps !== null && overrideAmps >= (dailyAmps ?? 0) ? 'override' : 'daily plan';
    if (desired !== current.amperage || !shaped) return { amps: desired, reason: `${p.slot} slot, ${source}` };
    return { amps: null, reason: 'up to date' };
  }
  // Between slots an override still writes right away and a fixed conflict
  // may raise tonight's amps; the daily plan waits for its slot.
  const offs = [overrideAmps, p.fixRaiseAmps].filter((a): a is number => typeof a === 'number' && a > 0);
  const want = offs.length ? Math.max(...offs) : 0;
  if (want > 0 && (want > current.amperage || !shaped)) {
    return { amps: want, reason: overrideAmps !== null && want === overrideAmps ? 'override' : 'shift conflict fixed, raised' };
  }
  return { amps: null, reason: 'waiting for the next write slot' };
}
