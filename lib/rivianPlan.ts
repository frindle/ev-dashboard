// The Rivian's coming-night plan from its inputs (EV charge plan #2/#3). Pure
// (process-TZ local time) so node:test can load this file; the IO wrapper that
// gathers the inputs is lib/rivianNightPlan.ts.
import {
  localDayNumber, nextUseDay, planTonight, plannedFor, topUpLimitFor,
  type NeedEstimate, type Shift, type TonightResult,
} from './chargePlan.ts';
import type { PeakNightIn } from './peakPlan.ts';

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
  // EV plan #7: expected use in % from the daily-use log (lib/needModels.ts
  // liveNeed). A null kind falls back to the charge-history estimate.
  useOverride?: { work: number | null; off: number | null } | null;
  // Rev 18: room under the day peak for the serve day and the two after it (lib/peakForecast.ts).
  peakNights?: PeakNightIn[] | null;
  // Days with a typed need (/charging, /trips, the calendar), as the day's total driving in % of
  // the battery with no margin (lib/tripPlan.ts needUsePct). It only raises that day's expected use.
  typedUse?: Record<number, number> | null;
}

export interface BuiltPlan {
  serveDay: number;
  socUsed: number | null;       // the SoC the plan started from (after the day's use is taken off)
  usePctWork: number;
  usePctOff: number;
  needSource: { work: 'daily-use' | 'charge-history'; off: 'daily-use' | 'charge-history' };
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
  if (!(p.kwhPerPct > 0)) return null;
  const est = p.est;
  const hist = (isWork: boolean): number | null => (est ? plannedFor(est, isWork) / p.kwhPerPct : null);
  const ow = p.useOverride?.work, oo = p.useOverride?.off;
  const usePctWork = typeof ow === 'number' && Number.isFinite(ow) ? ow : hist(true);
  const usePctOff = typeof oo === 'number' && Number.isFinite(oo) ? oo : hist(false);
  if (usePctWork === null || usePctOff === null) return null;
  const needSource = {
    work: usePctWork === ow ? 'daily-use' as const : 'charge-history' as const,
    off: usePctOff === oo ? 'daily-use' as const : 'charge-history' as const,
  };
  const serveDay = nextUseDay(p.nowMs);
  const todayIsWork = !!p.workDays?.has(localDayNumber(p.nowMs));
  const typed = p.typedUse ?? null;
  const todayUse = Math.max(todayIsWork ? usePctWork : usePctOff, typed?.[localDayNumber(p.nowMs)] ?? 0);
  const rawSoc = typeof p.state?.chargePercent === 'number' && p.state.chargePercent > 0 ? p.state.chargePercent : null;
  const socUsed = socForPlan(p.nowMs, rawSoc, p.state?.isPluggedIn ?? null, todayUse, p.margin);
  const result = planTonight({
    day: serveDay, shifts: p.shifts, workDays: p.workDays, usePctWork, usePctOff,
    socPct: socUsed, limitPct: p.state?.chargeLimit, margin: p.margin, floorPct: p.floorPct,
    topUpLimitPct: topUpLimitFor(p.forecastHighF), kwhPerPct: p.kwhPerPct, minAmps: p.minAmps, maxAmps: p.maxAmps,
    peak: p.peakNights ?? null, usePctByDay: typed,
  });
  return { serveDay, socUsed, usePctWork, usePctOff, needSource, result };
}

export interface ForecastTemp { ms: number; tempF: number }

// OpenWeatherMap 5-day/3-hour entries as (time, temperature) pairs.
export function forecastTempsFrom(list: Array<{ dt?: number; main?: { temp?: number } }>): ForecastTemp[] {
  const out: ForecastTemp[] = [];
  for (const e of list) {
    const t = e.main?.temp;
    if (typeof e.dt === 'number' && typeof t === 'number' && Number.isFinite(t)) out.push({ ms: e.dt * 1000, tempF: t });
  }
  return out;
}

// EV plan Rev 9: the forecast at the drive times (leaving and coming home),
// not the day's high. For each time, the nearest forecast entry within 3h;
// empty when there are no shifts that day or no entry is close enough.
export function driveTimeTemps(temps: ForecastTemp[], shifts: Shift[], day: number, departBufferMin = 60): number[] {
  const out: number[] = [];
  const near = (ms: number) => {
    let best: ForecastTemp | null = null;
    for (const t of temps) if (!best || Math.abs(t.ms - ms) < Math.abs(best.ms - ms)) best = t;
    return best && Math.abs(best.ms - ms) <= 3 * 3_600_000 ? best.tempF : null;
  };
  for (const s of shifts) {
    if (s.day !== day) continue;
    for (const ms of [s.startMs - departBufferMin * 60_000, s.endMs]) {
      const t = near(ms);
      if (t !== null) out.push(t);
    }
  }
  return out;
}

// Highest 3-hourly forecast temperature on local day `day`; null when none fall on it.
export function highOnDay(temps: ForecastTemp[], day: number): number | null {
  let hi: number | null = null;
  for (const t of temps) {
    const d = new Date(t.ms);
    if (Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000) !== day) continue;
    if (hi === null || t.tempF > hi) hi = t.tempF;
  }
  return hi;
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
