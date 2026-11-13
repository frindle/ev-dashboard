// Charge-plan history in InfluxDB, so the plan can be scored against what
// happened (ev_vehicle_state: SoC on getting home, odometer):
//
//   ev_shift_day work=1|0[,depart_min=..,home_min=..] <local midnight ms>
//     One point per day from the shift calendar (no titles, just the flag).
//     work=0 on time-off days too. depart_min / home_min are minutes after
//     that day's local midnight when Penn leaves (shift start - 1h) and is
//     home (shift end + 20 min, so past 1440 after midnight); work days only.
//     Rewritten on each calendar refresh; a day's point is overwritten in
//     place, so edits to future shifts land. Keeps the history after the
//     calendar moves to Nextcloud.
//   ev_charge_plan,vehicle=rivian ewma_kwh=..,planned_kwh=..,... <ms>
//     The Rivian plan on every charge-control run (15 min). Every field but
//     control_error is a float (booleans 0/1); fields that are unknown are left out. Includes
//     window_hours, next_window_hours, buffer_pct, kwh_per_pct, plugged_in and
//     slot (1 = the 08:15 forecast run, 2 = the 23:00 update run, absent
//     otherwise). control_error is the one string field (the scrubbed reason a
//     run failed, only when it did); hold, no_need and no_need_room_kw record
//     the plug-in rule for no-need nights.
import { influxTarget, writeLines } from './chargeSessionInflux.ts';
import { DEPART_BUFFER_MIN, HOME_BUFFER_MIN, type Shift } from './chargePlan.ts';

export const SHIFT_MEASUREMENT = 'ev_shift_day';
export const PLAN_MEASUREMENT = 'ev_charge_plan';
export const SHIFT_DAYS_BACK = 400;
export const SHIFT_DAYS_AHEAD = 30;
const DAY_MS = 86_400_000;
const TIMEOUT_MS = 10_000;

type FetchLike = Parameters<typeof writeLines>[2];
type Env = Record<string, string | undefined>;

// Day number (days since 1970-01-01 of a local date) -> that date's local midnight.
export function localMidnightMs(day: number): number {
  const d = new Date(day * DAY_MS);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime();
}

export interface ShiftDayExtras {
  shifts?: Shift[];            // for depart_min / home_min
  timeOffDays?: Set<number>;   // days off because of time off: work=0, and they stretch the range
}

// Every day from the first work day (at most SHIFT_DAYS_BACK ago) through the
// last (at most SHIFT_DAYS_AHEAD ahead); time-off days stretch the range too.
// Empty set and no time off -> no lines.
export function shiftDayLines(workDays: Set<number>, today: number, extra: ShiftDayExtras = {}): string[] {
  const off = extra.timeOffDays ?? new Set<number>();
  if (!workDays.size && !off.size) return [];
  let lo = Infinity, hi = -Infinity;
  for (const d of [...workDays, ...off]) { if (d < lo) lo = d; if (d > hi) hi = d; }
  lo = Math.max(lo, today - SHIFT_DAYS_BACK);
  hi = Math.min(hi, today + SHIFT_DAYS_AHEAD);
  const byDay = new Map<number, Shift[]>();
  for (const s of extra.shifts ?? []) byDay.set(s.day, [...(byDay.get(s.day) ?? []), s]);
  const out: string[] = [];
  for (let d = lo; d <= hi; d++) {
    const work = workDays.has(d) && !off.has(d);
    const mid = localMidnightMs(d);
    let times = '';
    const list = work ? byDay.get(d) : undefined;
    if (list?.length) {
      // shifts that disagree: earliest start, latest end (the planner picks the safe reading)
      const depart = Math.min(...list.map((s) => s.startMs)) - DEPART_BUFFER_MIN * 60_000;
      const home = Math.max(...list.map((s) => s.endMs)) + HOME_BUFFER_MIN * 60_000;
      times = `,depart_min=${Math.round((depart - mid) / 60_000)},home_min=${Math.round((home - mid) / 60_000)}`;
    }
    out.push(`${SHIFT_MEASUREMENT} work=${work ? 1 : 0}${times} ${mid}`);
  }
  return out;
}

export type PlanFields = Record<string, number | boolean | string | null | undefined>;

// Line-protocol string field value: double-quoted, with backslash and quote escaped; newlines
// become spaces (a raw newline would end the line).
export function quoteFieldString(v: string): string {
  return '"' + v.replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

export function planLine(vehicle: string, fields: PlanFields, ms: number): string | null {
  return fieldLine(PLAN_MEASUREMENT, vehicle, fields, ms);
}

// One line for `measurement,vehicle=<id>` from the known fields; null when none are usable.
export function fieldLine(measurement: string, vehicle: string, fields: PlanFields, ms: number): string | null {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'boolean') parts.push(`${k}=${v ? 1 : 0}`);
    else if (typeof v === 'number' && Number.isFinite(v)) parts.push(`${k}=${Math.round(v * 1000) / 1000}`);
    else if (typeof v === 'string' && v.length) parts.push(`${k}=${quoteFieldString(v)}`);
  }
  return parts.length ? `${measurement},vehicle=${vehicle} ${parts.join(',')} ${Math.round(ms)}` : null;
}

// Never throws. Writes the shift days once per calendar refresh (the source
// returns the same Set until it refreshes); a failed write is retried next call.
export function createShiftDayRecorder() {
  let written: Set<number> | null = null;
  return async function record(workDays: Set<number> | null, today: number, env: Env = process.env, fetchImpl?: FetchLike, extra?: ShiftDayExtras): Promise<number> {
    if (!workDays || workDays === written) return 0;
    try {
      const target = influxTarget(env);
      if (!target) return 0;
      const n = await writeLines(shiftDayLines(workDays, today, extra), target, fetchImpl, TIMEOUT_MS);
      written = workDays;
      return n;
    } catch (e) {
      console.error('[shifts] influx write failed:', e instanceof Error ? e.message : e);
      return 0;
    }
  };
}

export async function recordPlan(vehicle: string, fields: PlanFields, ms: number, env: Env = process.env, fetchImpl?: FetchLike): Promise<boolean> {
  try {
    const target = influxTarget(env);
    const line = planLine(vehicle, fields, ms);
    if (!target || !line) return false;
    await writeLines([line], target, fetchImpl, TIMEOUT_MS);
    return true;
  } catch (e) {
    console.error('[charge-plan] influx write failed:', e instanceof Error ? e.message : e);
    return false;
  }
}

export const recordShiftDays = createShiftDayRecorder();
