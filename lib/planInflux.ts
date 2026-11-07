// Charge-plan history in InfluxDB, so the plan can be scored against what
// happened (ev_vehicle_state: SoC on getting home, odometer):
//
//   ev_shift_day work=1|0 <local midnight ms>
//     One point per day from the shift calendar (no titles, just the flag).
//     Rewritten on each calendar refresh; a day's point is overwritten in
//     place, so edits to future shifts land. Keeps the history after the
//     calendar moves to Nextcloud.
//   ev_charge_plan,vehicle=rivian ewma_kwh=..,planned_kwh=..,... <ms>
//     The Rivian plan on every charge-control run (15 min). Every field is a
//     float (booleans 0/1); fields that are unknown are left out.
import { influxTarget, writeLines } from './chargeSessionInflux.ts';

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

// Every day from the first work day (at most SHIFT_DAYS_BACK ago) through the
// last (at most SHIFT_DAYS_AHEAD ahead). Empty set -> no lines.
export function shiftDayLines(workDays: Set<number>, today: number): string[] {
  if (!workDays.size) return [];
  let lo = Infinity, hi = -Infinity;
  for (const d of workDays) { if (d < lo) lo = d; if (d > hi) hi = d; }
  lo = Math.max(lo, today - SHIFT_DAYS_BACK);
  hi = Math.min(hi, today + SHIFT_DAYS_AHEAD);
  const out: string[] = [];
  for (let d = lo; d <= hi; d++) out.push(`${SHIFT_MEASUREMENT} work=${workDays.has(d) ? 1 : 0} ${localMidnightMs(d)}`);
  return out;
}

export type PlanFields = Record<string, number | boolean | null | undefined>;

export function planLine(vehicle: string, fields: PlanFields, ms: number): string | null {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'boolean') parts.push(`${k}=${v ? 1 : 0}`);
    else if (typeof v === 'number' && Number.isFinite(v)) parts.push(`${k}=${Math.round(v * 1000) / 1000}`);
  }
  return parts.length ? `${PLAN_MEASUREMENT},vehicle=${vehicle} ${parts.join(',')} ${Math.round(ms)}` : null;
}

// Never throws. Writes the shift days once per calendar refresh (the source
// returns the same Set until it refreshes); a failed write is retried next call.
export function createShiftDayRecorder() {
  let written: Set<number> | null = null;
  return async function record(workDays: Set<number> | null, today: number, env: Env = process.env, fetchImpl?: FetchLike): Promise<number> {
    if (!workDays || workDays === written) return 0;
    try {
      const target = influxTarget(env);
      if (!target) return 0;
      const n = await writeLines(shiftDayLines(workDays, today), target, fetchImpl, TIMEOUT_MS);
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
