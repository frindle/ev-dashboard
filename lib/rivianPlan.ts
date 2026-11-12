// The Rivian's coming-night plan from its inputs (EV charge plan #2/#3). Pure
// (process-TZ local time) so node:test can load this file; the IO wrapper that
// gathers the inputs is lib/rivianNightPlan.ts.
import {
  localDayNumber, nextUseDay, planTonight, plannedFor, topUpLimitFor,
  type NeedEstimate, type Shift, type TonightResult,
} from './chargePlan.ts';

export interface PlanState {
  chargePercent?: number | null;
  chargeLimit?: number | null;
  isPluggedIn?: boolean | null;
}

export interface BuildInput {
  nowMs: number;
  est: NeedEstimate | null;
  shifts: Shift[];
  workDays: Set<number> | null;
  state: PlanState | null;
  kwhPerPct: number;
  floorPct: number | null;
  margin: number;
  forecastHighF: number | null;   // the high of the day the charge serves
  minAmps: number;
  maxAmps: number;
}

export interface BuiltPlan {
  serveDay: number;
  socUsed: number | null;       // the SoC the plan started from (after the day's use is taken off)
  usePctWork: number;
  usePctOff: number;
  result: TonightResult;
}

// SoC the plan starts from. Inside the window it is the real SoC. Before
// 23:00 (the 08:15 forecast) the car is still to be driven today: today's use
// x margin comes off. From 23:00 (the update) a plugged-in car is read as is;
// an unplugged one gets half of today's use x margin taken off (it is
// somewhere in the day).
export function socForPlan(
  nowMs: number, soc: number | null, plugged: boolean | null, todayUsePct: number, margin: number,
): number | null {
  if (soc === null) return null;
  const d = new Date(nowMs);
  const min = d.getHours() * 60 + d.getMinutes();
  if (min < 8 * 60) return soc;
  if (min < 23 * 60) return Math.max(0, soc - todayUsePct * margin);
  return plugged ? soc : Math.max(0, soc - 0.5 * todayUsePct * margin);
}

export function buildRivianPlan(p: BuildInput): BuiltPlan | null {
  if (!p.est || !(p.kwhPerPct > 0)) return null;
  const serveDay = nextUseDay(p.nowMs);
  const usePctWork = plannedFor(p.est, true) / p.kwhPerPct;
  const usePctOff = plannedFor(p.est, false) / p.kwhPerPct;
  const todayIsWork = !!p.workDays?.has(localDayNumber(p.nowMs));
  const todayUse = todayIsWork ? usePctWork : usePctOff;
  const rawSoc = typeof p.state?.chargePercent === 'number' && p.state.chargePercent > 0 ? p.state.chargePercent : null;
  const socUsed = socForPlan(p.nowMs, rawSoc, p.state?.isPluggedIn ?? null, todayUse, p.margin);
  const result = planTonight({
    day: serveDay, shifts: p.shifts, workDays: p.workDays, usePctWork, usePctOff,
    socPct: socUsed, limitPct: p.state?.chargeLimit, margin: p.margin, floorPct: p.floorPct,
    topUpLimitPct: topUpLimitFor(p.forecastHighF), kwhPerPct: p.kwhPerPct, minAmps: p.minAmps, maxAmps: p.maxAmps,
  });
  return { serveDay, socUsed, usePctWork, usePctOff, result };
}

// Highest forecast temperature (F) among OpenWeatherMap 5-day/3-hour entries
// that fall on local day `day`. null when none do.
export function forecastHighFor(
  list: Array<{ dt?: number; main?: { temp_max?: number; temp?: number } }>, day: number,
): number | null {
  let hi: number | null = null;
  for (const e of list) {
    if (typeof e.dt !== 'number') continue;
    const d = new Date(e.dt * 1000);
    if (Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000) !== day) continue;
    const t = e.main?.temp_max ?? e.main?.temp;
    if (typeof t === 'number' && (hi === null || t > hi)) hi = t;
  }
  return hi;
}
