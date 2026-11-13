// Backtest for the EV peak cap (#9b): on the uploaded history, how many days the car set the day's
// peak, and by how many kW, under today's plan vs the cap (median x 0.8 and the p20 variant).
// Pure; scripts/peak-cap-backtest.ts feeds it and prints the aggregates. Aggregates only: no dates.
//
// A day counts as "car set the peak" when the night peak (00:00-08:00) beat the day peak (08:00-24:00),
// by that excess. The cap cases replay the night with the EV share limited to the cap kW (house load
// unchanged); a night whose cap is below the car's lowest amps keeps its charge (the one-night-over rule).
// It does not move charge between nights, so it understates what the real plan saves.
import { PEAK_CAP_MARGIN, KW_PER_AMP } from './chargePlan.ts';
import { dayPeakForecast, nightHouseForecast, weightedQuantile, similarity, type PeakDay } from './peakCap.ts';

export const DEMAND_USD_PER_KW_DAY = 0.14;
export const MIN_CAR_KW = 6 * KW_PER_AMP;

export interface BacktestDay extends PeakDay {
  nightKw: number | null;          // the night's highest interval
  evKwAtNightPeak: number | null;  // EV share of it
}

export interface CaseResult { days: number; daysCarSetPeak: number; excessKwTotal: number; excessKwMax: number; usd: number }
export interface BacktestResult {
  daysAnalysed: number; daysWithEv: number; skippedNoForecast: number;
  today: CaseResult; median80: CaseResult; p20: CaseResult;
}

const empty = (): CaseResult => ({ days: 0, daysCarSetPeak: 0, excessKwTotal: 0, excessKwMax: 0, usd: 0 });
function add(c: CaseResult, dayKw: number, nightKw: number) {
  c.days++;
  const ex = nightKw - dayKw;
  if (ex > 1e-9) { c.daysCarSetPeak++; c.excessKwTotal += ex; c.excessKwMax = Math.max(c.excessKwMax, ex); c.usd += ex * DEMAND_USD_PER_KW_DAY; }
}

export function backtestPeakCap(days: BacktestDay[]): BacktestResult {
  const out: BacktestResult = { daysAnalysed: 0, daysWithEv: 0, skippedNoForecast: 0, today: empty(), median80: empty(), p20: empty() };
  days.forEach((d, i) => {
    if (d.dayKw === null || d.nightKw === null) return;
    out.daysAnalysed++;
    const ev = d.evKwAtNightPeak ?? 0;
    if (!(ev > 0)) return;
    out.daysWithEv++;
    const others = days.filter((_, j) => j !== i);   // leave one out
    const t = { month: Number(d.date.slice(5, 7)), isWork: d.isWork, tempF: d.tempF };
    const peak = dayPeakForecast(others, t);
    const house = nightHouseForecast(others, t);
    const p20items = others.flatMap((o) => (o.dayKw === null ? [] : [{ v: o.dayKw, w: similarity(o, t) }]));
    const p20 = weightedQuantile(p20items, 0.2);
    if (peak.kw === null || house.kw === null || p20 === null) { out.skippedNoForecast++; return; }
    add(out.today, d.dayKw, d.nightKw);
    const houseNow = Math.max(0, d.nightKw - ev);
    const replay = (capKw: number) => houseNow + (capKw < MIN_CAR_KW ? ev : Math.min(ev, capKw));
    add(out.median80, d.dayKw, replay(Math.max(0, PEAK_CAP_MARGIN * peak.kw - house.kw)));
    add(out.p20, d.dayKw, replay(Math.max(0, p20 - house.kw)));
  });
  return out;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
export function formatBacktest(r: BacktestResult): string[] {
  const row = (name: string, c: CaseResult) =>
    `${name}: days ${c.days}, car set the peak ${c.daysCarSetPeak}, excess kW total ${r2(c.excessKwTotal)} max ${r2(c.excessKwMax)}, $${r2(c.usd)} at $${DEMAND_USD_PER_KW_DAY}/kW/day`;
  return [
    `days analysed ${r.daysAnalysed}, with EV charging ${r.daysWithEv}, skipped (too little history) ${r.skippedNoForecast}`,
    row('today', r.today), row('cap median x0.8', r.median80), row('cap p20 (no margin)', r.p20),
  ];
}
