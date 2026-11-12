// Need-estimate candidates for the Rivian night plan (EV charge plan #7) and the
// pure walk-forward simulation the backtest script drives. No IO, no clock, so
// node:test can load it. Units are battery % per day.
//
//   (a) ewmaNeed  recency-weighted mean of daily % used, split work/off.
//   (b) tempNeed  work-day commute miles / (mi per 1% at the day's temperature)
//                 + parked drain. No margin here: like needEstimate, models return
//                 the expected use and the planner (nightPlan) applies the 1.1
//                 margin to the put-back and the reach. Curve choice: a quadratic in temperature
//                 fitted to per-drive mi/% by weighted least squares, weights =
//                 the drive's % drop (so it estimates sum(miles)/sum(%), not a
//                 mean of noisy 1%-resolution ratios), made robust with 4 Huber
//                 IRLS passes. Temperature is clamped to the fitted range (flat,
//                 never extrapolated) and the result to [1.2, 5] mi/%.
//   planNeed      work days use (b) (or max(a,b), see NeedRule), off days (a),
//                 null when daily use covers < 5 of the last 7 days.
//   simulate      two modes: 'reach' leaves every morning at only the minimum
//                 (floor + use x margin), which scores how often the estimate
//                 itself is beaten; 'live' runs the real nightPlan (put-back /
//                 catch-up, heat top-up cap, 6-48A), which is what the car does.
//
// Day keys are local 'YYYY-MM-DD' strings; they sort chronologically, so
// `date < D` is "known before the night that plans day D".
import { ampsFor, CHARGE_WINDOW_HOURS, dayTimeMs, EWMA_HALF_LIFE_DAYS, MIN_DAYS_PER_KIND, nightPlan, nightWindow, topUpLimitFor, WORK_RATE_HALF_LIFE_DAYS } from './chargePlan.ts';
import { KWH_PER_PCT_SEED } from './kwhPerPct.ts';
import { localDate } from './rivianDailyUse.ts';

export const WORK_MARGIN = 1.1;   // the Rivian's arrivalDriveMargin (lib/config.ts)
export const LIVE_MIN_AMPS = 6;   // RIVIAN_MIN_AMPS / RIVIAN_MAX_AMPS (rivianNightPlan.ts imports server-only modules)
export const LIVE_MAX_AMPS = 48;
export const SPARSE_BAND_MIN_DRIVES = 10;
export const SPARSE_MI_PER_PCT = 1.95;
export const BAND_MISS_THRESHOLD = 0.10;
export const BAND_MIN_DAYS_FOR_OVERRIDE = 5;   // fewer scored work days in a band can't prove a miss rate
export const OVERRIDE_QUANTILE = 0.25;
export const MIN_FIT_DROP_PCT = 2;
export const MIN_FIT_MILES = 3;
export const MIN_FIT_DRIVES = 8;
export const MIN_COVERAGE_DAYS = 5;            // of the last COVERAGE_WINDOW days
export const COVERAGE_WINDOW = 7;
export const ROLLING_DAYS = 14;
export const MIN_HISTORY_DAYS = 14;
export const REFIT_DAYS = 7;
export const BAND_WIDTH_F = 10;
export const MI_PER_PCT_MIN = 1.2;
export const MI_PER_PCT_MAX = 5;
export const DEFAULT_LIMIT_PCT = 70;
export const DEFAULT_FLOOR_PCT = 25;

export interface DailyUse {
  date: string;
  unknown: boolean;
  used_pct: number | null;
  drive_pct: number | null;
  parked_pct: number | null;
  drives: number;
  miles: number;
}

export interface DriveIn {
  start: string;
  end: string;
  start_soc: number | null;
  end_soc: number | null;
  miles: number;
  temp_f: number | null;
}

export interface FitDrive {
  date: string;
  miPerPct: number;
  dropPct: number;
  tempF: number;
  work: boolean;
}

export interface NeedData {
  rows: DailyUse[];                       // sorted by date
  rowByDate: Map<string, DailyUse>;
  drives: FitDrive[];                     // valid for fitting (drop >= 2, miles >= 3, temp known), sorted by date
  dayTemp: Map<string, number>;           // mean drive temp_f per local day
  dayTempMax: Map<string, number>;        // hottest drive temp_f per local day (stands in for the forecast high)
  workDays: Set<string>;
}

const dayNum = (date: string): number => Math.round(Date.parse(date + 'T00:00:00Z') / 86_400_000);
const dateOf = (n: number): string => new Date(n * 86_400_000).toISOString().slice(0, 10);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export function buildNeedData(rows: DailyUse[], drives: DriveIn[], workdays: string[]): NeedData {
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const workDays = new Set(workdays);
  const temps = new Map<string, number[]>();
  const fit: FitDrive[] = [];
  for (const d of drives) {
    const ms = Date.parse(d.start);
    if (!Number.isFinite(ms)) continue;
    const date = localDate(ms);
    if (isNum(d.temp_f)) {
      const l = temps.get(date) ?? [];
      l.push(d.temp_f);
      temps.set(date, l);
    }
    if (!isNum(d.start_soc) || !isNum(d.end_soc) || !isNum(d.miles) || !isNum(d.temp_f)) continue;
    const drop = d.start_soc - d.end_soc;
    if (drop < MIN_FIT_DROP_PCT || d.miles < MIN_FIT_MILES) continue;
    fit.push({ date, miPerPct: d.miles / drop, dropPct: drop, tempF: d.temp_f, work: workDays.has(date) });
  }
  fit.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const dayTemp = new Map<string, number>(), dayTempMax = new Map<string, number>();
  for (const [date, l] of temps) { dayTemp.set(date, l.reduce((s, x) => s + x, 0) / l.length); dayTempMax.set(date, Math.max(...l)); }
  return { rows: sorted, rowByDate: new Map(sorted.map((r) => [r.date, r])), drives: fit, dayTemp, dayTempMax, workDays };
}

const knownUse = (r: DailyUse): r is DailyUse & { used_pct: number } => !r.unknown && isNum(r.used_pct);

// ---- (a) ----------------------------------------------------------------

export interface EwmaNeed { pct: number; source: 'kind' | 'all' }

// Recency-weighted mean of used_pct over days before `asOf`, restricted to the
// same kind (work/off) at WORK_RATE_HALF_LIFE_DAYS; with fewer than
// MIN_DAYS_PER_KIND such days, the all-days mean at EWMA_HALF_LIFE_DAYS (the
// %-unit twin of ewmaDailyKwh). null without any known day.
export function ewmaNeed(data: NeedData, asOf: string, isWork: boolean): EwmaNeed | null {
  const now = dayNum(asOf);
  let kSum = 0, kW = 0, kN = 0, aSum = 0, aW = 0;
  for (const r of data.rows) {
    if (r.date >= asOf) break;
    if (!knownUse(r)) continue;
    const age = Math.max(0, now - dayNum(r.date));
    const wk = 0.5 ** (age / WORK_RATE_HALF_LIFE_DAYS);
    const wa = 0.5 ** (age / EWMA_HALF_LIFE_DAYS);
    aSum += wa * r.used_pct; aW += wa;
    if (data.workDays.has(r.date) === isWork) { kSum += wk * r.used_pct; kW += wk; kN++; }
  }
  if (kN >= MIN_DAYS_PER_KIND && kW > 0) return { pct: kSum / kW, source: 'kind' };
  return aW > 0 ? { pct: aSum / aW, source: 'all' } : null;
}

// ---- (b) ----------------------------------------------------------------

export interface BandStat { band: number; workDrives: number; median: number | null; p25: number | null }

export interface TempCurve {
  coef: [number, number, number];   // quadratic in u = (tempF - 60) / 30
  tMin: number;
  tMax: number;
  bands: Map<number, BandStat>;     // work-day drives per 10F band
  workQuantiles: Map<number, number[]>;
}

export const bandOf = (tempF: number): number => Math.floor(tempF / BAND_WIDTH_F) * BAND_WIDTH_F;

export function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function solve3(a: number[][], b: number[]): [number, number, number] | null {
  const m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-12) return null;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = c + 1; r < 3; r++) {
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k];
    }
  }
  const x = [0, 0, 0];
  for (let r = 2; r >= 0; r--) {
    let s = m[r][3];
    for (let k = r + 1; k < 3; k++) s -= m[r][k] * x[k];
    x[r] = s / m[r][r];
  }
  return [x[0], x[1], x[2]];
}

const u = (t: number): number => (t - 60) / 30;

function wls(pts: FitDrive[], w: number[]): [number, number, number] | null {
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const B = [0, 0, 0];
  pts.forEach((p, i) => {
    const x = u(p.tempF), v = [1, x, x * x];
    for (let r = 0; r < 3; r++) {
      B[r] += w[i] * v[r] * p.miPerPct;
      for (let c = 0; c < 3; c++) A[r][c] += w[i] * v[r] * v[c];
    }
  });
  return solve3(A, B);
}

const evalQuad = (c: [number, number, number], t: number): number => c[0] + c[1] * u(t) + c[2] * u(t) * u(t);

// Fit from drives dated before `before`. null with too few drives or < 3
// distinct temperatures (a quadratic can't be told from a line then).
export function fitTempCurve(data: NeedData, before: string): TempCurve | null {
  const pts: FitDrive[] = [];
  for (const d of data.drives) { if (d.date >= before) break; pts.push(d); }
  if (pts.length < MIN_FIT_DRIVES || new Set(pts.map((p) => Math.round(p.tempF))).size < 3) return null;
  const base = pts.map((p) => p.dropPct);
  let w = base.slice();
  let coef = wls(pts, w);
  for (let it = 0; it < 4 && coef; it++) {
    const res = pts.map((p) => p.miPerPct - evalQuad(coef!, p.tempF));
    const absSorted = res.map(Math.abs).sort((a, b) => a - b);
    const s = Math.max(0.05, 1.4826 * (quantile(absSorted, 0.5) ?? 0));
    w = base.map((b, i) => b * Math.min(1, (1.345 * s) / Math.max(1e-9, Math.abs(res[i]))));
    coef = wls(pts, w) ?? coef;
  }
  if (!coef) return null;
  const workQuantiles = new Map<number, number[]>();
  for (const p of pts) {
    if (!p.work) continue;
    const b = bandOf(p.tempF);
    const l = workQuantiles.get(b) ?? [];
    l.push(p.miPerPct);
    workQuantiles.set(b, l);
  }
  const bands = new Map<number, BandStat>();
  for (const [band, l] of workQuantiles) {
    l.sort((a, b) => a - b);
    bands.set(band, { band, workDrives: l.length, median: quantile(l, 0.5), p25: quantile(l, OVERRIDE_QUANTILE) });
  }
  const temps = pts.map((p) => p.tempF);
  return { coef, tMin: Math.min(...temps), tMax: Math.max(...temps), bands, workQuantiles };
}

// The bare fitted curve at tempF (clamped to the fitted range and mi/% limits).
export function curveValue(curve: TempCurve, tempF: number): number {
  return Math.min(MI_PER_PCT_MAX, Math.max(MI_PER_PCT_MIN, evalQuad(curve.coef, Math.min(curve.tMax, Math.max(curve.tMin, tempF)))));
}

export type BandOverrides = Map<number, number>;   // band -> quantile of the band's work-day mi/% to use

export type CurveSource = 'curve' | 'sparse' | 'override';

// mi per 1% at tempF: sparse band (< 10 work-day drives) -> 1.95 (never above
// the curve, so it can only raise the need); overridden band -> its quantile;
// otherwise the clamped curve.
export function miPerPctAt(curve: TempCurve, tempF: number, overrides?: BandOverrides): { value: number; source: CurveSource } {
  const band = bandOf(tempF);
  const stat = curve.bands.get(band);
  const curveV = curveValue(curve, tempF);
  if (!stat || stat.workDrives < SPARSE_BAND_MIN_DRIVES) return { value: Math.min(curveV, SPARSE_MI_PER_PCT), source: 'sparse' };
  const q = overrides?.get(band);
  if (q !== undefined) {
    const v = quantile(curve.workQuantiles.get(band) ?? [], q);
    if (v !== null) return { value: v, source: 'override' };
  }
  return { value: curveV, source: 'curve' };
}

function rollingMedian(vals: number[], n: number): number | null {
  const tail = vals.slice(-n).sort((a, b) => a - b);
  return quantile(tail, 0.5);
}

// Temperature for day D: its own drives' mean (stands in for the forecast), else the nearest earlier day's.
export function tempFor(data: NeedData, date: string): number | null {
  const own = data.dayTemp.get(date);
  if (own !== undefined) return own;
  let best: string | null = null;
  for (const k of data.dayTemp.keys()) if (k < date && (best === null || k > best)) best = k;
  return best === null ? null : data.dayTemp.get(best)!;
}

export interface TempNeed { pct: number; tempF: number; band: number; source: CurveSource }

// tempOverride: the forecast temperature to plan with (live); absent = tempFor.
export function tempNeed(
  data: NeedData, asOf: string, curve: TempCurve | null, overrides?: BandOverrides, tempOverride?: number | null,
): TempNeed | null {
  if (!curve) return null;
  const tempF = typeof tempOverride === 'number' && Number.isFinite(tempOverride) ? tempOverride : tempFor(data, asOf);
  if (tempF === null) return null;
  const miles: number[] = [], parked: number[] = [];
  for (const r of data.rows) {
    if (r.date >= asOf) break;
    if (!knownUse(r)) continue;
    if (isNum(r.parked_pct)) parked.push(Math.max(0, r.parked_pct));
    if (data.workDays.has(r.date) && r.drives > 0 && r.miles > 0) miles.push(r.miles);
  }
  const commute = rollingMedian(miles, ROLLING_DAYS);
  if (commute === null || miles.length < 3) return null;
  const park = rollingMedian(parked, ROLLING_DAYS) ?? 0;
  const { value, source } = miPerPctAt(curve, tempF, overrides);
  return { pct: commute / value + park, tempF, band: bandOf(tempF), source };
}

// ---- combined -----------------------------------------------------------

// Which rule the plan uses on work days. The backtest sets this by comparing
// short mornings: if (b) leaves more than (a), 'max'. Wiring later is one line:
// planNeed(..., NEED_RULE).
export interface NeedRule { workDay: 'b' | 'max' }
export const NEED_RULE: NeedRule = { workDay: 'b' };

export function ruleFromShorts(aShort: number, bShort: number): NeedRule {
  return { workDay: bShort > aShort ? 'max' : 'b' };
}

export function coverageOk(data: NeedData, asOf: string): boolean {
  const now = dayNum(asOf);
  let n = 0;
  for (let k = 1; k <= COVERAGE_WINDOW; k++) {
    const r = data.rowByDate.get(dateOf(now - k));
    if (r && knownUse(r)) n++;
  }
  return n >= MIN_COVERAGE_DAYS;
}

export interface PlannedNeed { pct: number; rule: 'a' | 'b' | 'max' | 'a-fallback' }

// null = the caller falls back to the charge-history needEstimate.
export function planNeed(
  data: NeedData, asOf: string, curve: TempCurve | null, overrides: BandOverrides | undefined, rule: NeedRule = NEED_RULE,
): PlannedNeed | null {
  if (!coverageOk(data, asOf)) return null;
  const isWork = data.workDays.has(asOf);
  const a = ewmaNeed(data, asOf, isWork);
  if (!isWork) return a ? { pct: a.pct, rule: 'a' } : null;
  const b = tempNeed(data, asOf, curve, overrides);
  if (!b) return a ? { pct: a.pct, rule: 'a-fallback' } : null;
  if (rule.workDay === 'max' && a) return { pct: Math.max(a.pct, b.pct), rule: 'max' };
  return { pct: b.pct, rule: 'b' };
}

// ---- live use (EV plan #7 winner) ----------------------------------------

// Backtest 2026-11-12 (Roamer seed, 142 scored days, inferred work days): in
// reach mode (b) with these bands on their 25th-percentile mi/% missed 10.2% of
// work days vs 20.5% for (a) and for the bare curve, so NEED_RULE stays 'b'.
// Live nightPlan: 1 short morning in 142 for every model, amps mean ~14, p90 20.
// Re-run scripts/backtest-need.mjs monthly and update this map.
export const LIVE_BAND_OVERRIDES: BandOverrides = new Map([[70, 0.25], [80, 0.25], [90, 0.25], [100, 0.25]]);

export interface LiveNeed {
  work: number | null;          // % per work day, no margin
  off: number | null;           // % per day off, no margin
  workSource: string;           // 'curve' | 'sparse' | 'override' | 'max' | 'a-fallback'
  tempF: number | null;         // temperature the work need was planned at
}

// The need for day `asOf` from the daily-use log. tempsF: forecast temperatures
// at the drive times; the worst one (highest need) wins; empty = tempFor.
// null when daily use covers < 5 of the last 7 days (caller keeps the
// charge-history estimate).
export function liveNeed(
  rows: DailyUse[], drives: DriveIn[], workdays: string[], asOf: string, tempsF: number[], rule: NeedRule = NEED_RULE,
): LiveNeed | null {
  const data = buildNeedData(rows, drives, workdays);
  if (!coverageOk(data, asOf)) return null;
  const curve = fitTempCurve(data, asOf);
  const temps = tempsF.filter((t) => Number.isFinite(t));
  let b: TempNeed | null = null;
  for (const t of temps.length ? temps : [null]) {
    const n = tempNeed(data, asOf, curve, LIVE_BAND_OVERRIDES, t);
    if (n && (!b || n.pct > b.pct)) b = n;
  }
  const aw = ewmaNeed(data, asOf, true);
  const ao = ewmaNeed(data, asOf, false);
  let work: number | null = b ? b.pct : aw?.pct ?? null;
  let workSource = b ? b.source : 'a-fallback';
  if (b && rule.workDay === 'max' && aw && aw.pct > b.pct) { work = aw.pct; workSource = 'max'; }
  return { work, off: ao?.pct ?? null, workSource, tempF: b?.tempF ?? null };
}

// ---- walk-forward simulation -------------------------------------------

export type SimMode = 'reach' | 'live';

export interface WalkOptions {
  limit?: number;
  floor?: number;
  kwhPerPct?: number;
  minHistoryDays?: number;
  margin?: number;          // default WORK_MARGIN
  mode?: SimMode;           // default 'reach'
}

export interface SimDay {
  date: string;
  isWork: boolean;
  need: number;
  actual: number;
  short: boolean;
  amps: number;
  nudge: boolean;
  band: number | null;
  source: string;
  morning: number;
  arrival: number;
}

export type NeedFn = (date: string, isWork: boolean, curve: TempCurve | null) => { pct: number; band?: number | null; source?: string } | null;

// First scoreable day: MIN_HISTORY_DAYS after the first daily-use row.
export function walkDates(data: NeedData, minHistoryDays = MIN_HISTORY_DAYS): string[] {
  if (!data.rows.length) return [];
  const startNum = dayNum(data.rows[0].date) + minHistoryDays;
  return data.rows.filter((r) => dayNum(r.date) >= startNum).map((r) => r.date);
}

// The weekly refit boundary at or before `date`; the curve for `date` is fitted
// on drives strictly before it, so it never sees `date` or later.
export function refitDateFor(startDate: string, date: string): string {
  const s = dayNum(startDate);
  return dateOf(s + Math.floor((dayNum(date) - s) / REFIT_DAYS) * REFIT_DAYS);
}

// Hours of the 00:00-08:00 window serving `date`: a work day is a shift
// leaving 11:00 local (nightWindow ends the window at min(08:00, start - 1h),
// so this is the full 8h), an off day has no shift. Taken from nightWindow so
// a future change to the window constants carries through.
export function windowHoursFor(date: string, isWork: boolean): number {
  const day = dayNum(date);
  const shifts = isWork ? [{ day, startMs: dayTimeMs(day, 11), endMs: dayTimeMs(day, 19) }] : [];
  const h = nightWindow(day, shifts).hours;
  return h > 0 ? h : CHARGE_WINDOW_HOURS;
}

// Each scoreable day is predicted from earlier data only; SoC is simulated
// arrival(D-1) -> morning(D) -> arrival(D) = morning - actual.
//   reach: morning = max(arrival, min(limit, floor + need x margin)).
//   live:  morning = arrival + nightPlan(...).totalPct (no next-night buffer;
//          the backtest has no shift times), heat top-up cap from the day's
//          hottest drive temperature, amps from nightPlan (6-48A, 2A steps).
// The chain restarts at `floor` after any day with unknown use (or no
// prediction). Short morning = arrival(D) < floor.
export function simulate(data: NeedData, needFn: NeedFn, opts: WalkOptions = {}): SimDay[] {
  const limit = opts.limit ?? DEFAULT_LIMIT_PCT;
  const floor = opts.floor ?? DEFAULT_FLOOR_PCT;
  const kwhPerPct = opts.kwhPerPct ?? KWH_PER_PCT_SEED;
  const margin = opts.margin ?? WORK_MARGIN;
  const mode: SimMode = opts.mode ?? 'reach';
  const dates = walkDates(data, opts.minHistoryDays ?? MIN_HISTORY_DAYS);
  if (!dates.length) return [];
  const start = dates[0];
  const curves = new Map<string, TempCurve | null>();
  const out: SimDay[] = [];
  let prevArrival = floor;
  let prevDate: string | null = null;
  for (const date of dates) {
    const row = data.rowByDate.get(date)!;
    if (prevDate !== null && dayNum(date) - dayNum(prevDate) !== 1) prevArrival = floor;
    prevDate = date;
    if (!knownUse(row)) { prevArrival = floor; continue; }
    const refit = refitDateFor(start, date);
    if (!curves.has(refit)) curves.set(refit, fitTempCurve(data, refit));
    const isWork = data.workDays.has(date);
    const n = needFn(date, isWork, curves.get(refit)!);
    if (!n) { prevArrival = floor; continue; }
    const hours = windowHoursFor(date, isWork);
    let morning: number, amps: number, nudge: boolean;
    if (mode === 'live') {
      const p = nightPlan({
        isWork, socPct: Math.max(0.01, prevArrival), limitPct: limit, usePct: n.pct, margin, floorPct: floor,
        topUpLimitPct: isWork ? topUpLimitFor(data.dayTempMax.get(date)) : null, windowHours: hours, kwhPerPct,
        minAmps: LIVE_MIN_AMPS, maxAmps: LIVE_MAX_AMPS,
      });
      morning = Math.max(0.01, prevArrival) + p.totalPct;
      amps = p.amps ?? 0;
      nudge = p.raiseLimitTo !== null;
    } else {
      const target = floor + n.pct * margin;
      morning = Math.max(prevArrival, Math.min(limit, target));
      amps = ampsFor((morning - prevArrival) * kwhPerPct, 0, 48, hours);
      nudge = target > limit;
    }
    const arrival = morning - row.used_pct;
    out.push({
      date, isWork, need: n.pct, actual: row.used_pct, short: arrival < floor,
      amps, nudge, band: n.band ?? null, source: n.source ?? '', morning, arrival,
    });
    prevArrival = arrival;
  }
  return out;
}

export function modelA(data: NeedData): NeedFn {
  return (date, isWork) => { const a = ewmaNeed(data, date, isWork); return a ? { pct: a.pct, source: a.source } : null; };
}

// Pass 1 uses no overrides; pass 2 gets the override map from pass-1 results.
export function modelB(data: NeedData, overrides?: BandOverrides): NeedFn {
  return (date, isWork, curve) => {
    if (!isWork) { const a = ewmaNeed(data, date, false); return a ? { pct: a.pct, source: 'off-a' } : null; }
    const b = tempNeed(data, date, curve, overrides);
    if (b) return { pct: b.pct, band: b.band, source: b.source };
    const a = ewmaNeed(data, date, true);
    return a ? { pct: a.pct, source: 'a-fallback' } : null;
  };
}

export function modelCombined(data: NeedData, overrides: BandOverrides | undefined, rule: NeedRule): NeedFn {
  return (date, _isWork, curve) => {
    const p = planNeed(data, date, curve, overrides, rule);
    if (!p) return null;
    const b = data.workDays.has(date) ? tempNeed(data, date, curve, overrides) : null;
    return { pct: p.pct, band: b ? b.band : null, source: p.rule };
  };
}

// Bands whose work days miss more than 10% (with enough days to say so).
export function overridesFromPass1(days: SimDay[]): BandOverrides {
  const tally = new Map<number, { n: number; short: number }>();
  for (const d of days) {
    if (!d.isWork || d.band === null) continue;
    const t = tally.get(d.band) ?? { n: 0, short: 0 };
    t.n++; if (d.short) t.short++;
    tally.set(d.band, t);
  }
  const out: BandOverrides = new Map();
  for (const [band, t] of tally) {
    if (t.n >= BAND_MIN_DAYS_FOR_OVERRIDE && t.short / t.n > BAND_MISS_THRESHOLD) out.set(band, OVERRIDE_QUANTILE);
  }
  return out;
}

export interface Summary {
  n: number; short: number; shortPct: number;
  workN: number; workShort: number; workShortPct: number;
  offN: number; offShort: number; offShortPct: number;
  meanAmps: number; p90Amps: number;
  meanAbsErr: number; bias: number; nudges: number;
}

export function summarize(days: SimDay[]): Summary {
  const pct = (a: number, b: number) => (b ? (100 * a) / b : 0);
  const work = days.filter((d) => d.isWork), off = days.filter((d) => !d.isWork);
  const amps = days.map((d) => d.amps).sort((a, b) => a - b);
  const sum = (f: (d: SimDay) => number) => days.reduce((s, d) => s + f(d), 0);
  const n = days.length;
  const ws = work.filter((d) => d.short).length, os = off.filter((d) => d.short).length;
  return {
    n, short: ws + os, shortPct: pct(ws + os, n),
    workN: work.length, workShort: ws, workShortPct: pct(ws, work.length),
    offN: off.length, offShort: os, offShortPct: pct(os, off.length),
    meanAmps: n ? sum((d) => d.amps) / n : 0, p90Amps: quantile(amps, 0.9) ?? 0,
    meanAbsErr: n ? sum((d) => Math.abs(d.need - d.actual)) / n : 0,
    bias: n ? sum((d) => d.need - d.actual) / n : 0,
    nudges: days.filter((d) => d.nudge).length,
  };
}
