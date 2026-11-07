// One-off Rivian charge override: "be at targetPct by byMs" for days that
// don't fit the daily plan. Works out the amps to run in every daily charge
// window between now and the deadline, counting the driving expected on the
// days in between (the daily EWMA need), and whether the car's charge limit
// has to be raised for the target to be reachable at all.
//
// Pure functions (process-TZ local time), so node:test can load this file.
import { CHARGE_EFFICIENCY, CHARGE_VOLTS } from './chargePlan.ts';

export const OVERRIDE_MIN_PCT = 50;   // Rivian accepts charge limits 50..100
export const OVERRIDE_MAX_PCT = 100;
export const OVERRIDE_MAX_DAYS = 14;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface ChargeOverride {
  targetPct: number;
  byMs: number;
}

// Daily charge window in local time: starts startMin minutes after midnight.
export interface ChargeWindow {
  startMin: number;
  durationMin: number;
}

export interface OverridePlanInput {
  override: ChargeOverride;
  nowMs: number;
  socPct: number | null | undefined;
  limitPct: number | null | undefined;
  packKwh: number;
  dailyKwh: number;
  window: ChargeWindow;
  minAmps: number;
  maxAmps: number;
}

export interface OverridePlan {
  needKwh: number;            // wall kWh: gap to the target + driving before the deadline
  hours: number;              // charge-window hours left before the deadline
  windows: number;            // charge windows (nights) left, including one in progress
  amps: number;               // to run in every remaining window
  feasible: boolean;          // false when even maxAmps falls short
  reachablePct: number;       // SoC at the deadline at `amps` (the target when feasible)
  raiseLimitTo: number | null; // the target, when it is above the car's charge limit
}

// null when the override is malformed or out of range.
export function validOverride(o: unknown, nowMs: number): ChargeOverride | null {
  const x = o as Partial<ChargeOverride> | null;
  if (!x || typeof x.targetPct !== 'number' || typeof x.byMs !== 'number') return null;
  if (!Number.isInteger(x.targetPct) || x.targetPct < OVERRIDE_MIN_PCT || x.targetPct > OVERRIDE_MAX_PCT) return null;
  if (!Number.isFinite(x.byMs) || x.byMs <= nowMs || x.byMs > nowMs + OVERRIDE_MAX_DAYS * DAY_MS) return null;
  return { targetPct: x.targetPct, byMs: x.byMs };
}

// The daily windows that overlap [fromMs, toMs], clipped to it, in order.
export function windowsBetween(fromMs: number, toMs: number, w: ChargeWindow): { startMs: number; endMs: number }[] {
  const out: { startMs: number; endMs: number }[] = [];
  const d = new Date(fromMs - DAY_MS);  // a window that started yesterday may still be running
  for (let i = 0; i <= OVERRIDE_MAX_DAYS + 2; i++) {
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, 0, w.startMin).getTime();
    if (start >= toMs) break;
    const end = start + w.durationMin * 60_000;
    const s = Math.max(start, fromMs);
    const e = Math.min(end, toMs);
    if (e > s) out.push({ startMs: s, endMs: e });
  }
  return out;
}

// null when the override has expired or SoC is unknown.
export function overridePlan(p: OverridePlanInput): OverridePlan | null {
  const o = p.override;
  const soc = p.socPct;
  if (!(o.byMs > p.nowMs) || typeof soc !== 'number' || !Number.isFinite(soc) || soc <= 0) return null;
  const wins = windowsBetween(p.nowMs, o.byMs, p.window);
  const hours = wins.reduce((h, x) => h + (x.endMs - x.startMs) / HOUR_MS, 0);
  // Driving before the deadline: a full day between consecutive windows, and
  // before the first one the share of the day's driving time still to come.
  // None after the last window: the deadline is the departure.
  let driveDays = Math.max(0, wins.length - 1);
  if (wins.length && wins[0].startMs > p.nowMs) {
    const dayMs = DAY_MS - p.window.durationMin * 60_000;
    driveDays += Math.min(1, (wins[0].startMs - p.nowMs) / dayMs);
  }
  const driveKwh = Math.max(0, p.dailyKwh) * driveDays;
  const gapKwh = (Math.max(0, o.targetPct - soc) / 100) * p.packKwh / CHARGE_EFFICIENCY;
  const needKwh = gapKwh + driveKwh;
  const kwhPerAmp = (CHARGE_VOLTS * hours) / 1000;
  const raw = kwhPerAmp > 0 ? Math.ceil(needKwh / kwhPerAmp / 2) * 2 : Infinity;
  const feasible = raw <= p.maxAmps;
  const amps = Math.min(p.maxAmps, Math.max(p.minAmps, Number.isFinite(raw) ? raw : p.maxAmps));
  const reachablePct = feasible
    ? o.targetPct
    : Math.min(o.targetPct, soc + (Math.max(0, amps * kwhPerAmp - driveKwh) * CHARGE_EFFICIENCY / p.packKwh) * 100);
  const limit = p.limitPct;
  const raiseLimitTo = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 && o.targetPct > limit ? o.targetPct : null;
  return { needKwh, hours, windows: wins.length, amps, feasible, reachablePct, raiseLimitTo };
}
