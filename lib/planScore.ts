// Forecast-vs-actual scoring of the Rivian night plan (pure; node:test loads it directly).
//
// A serve day is scored the next morning: the use the plan expected (kept in the plan store when a
// write slot ran) against what the daily-use log says the car used, the lowest SoC that day
// against the arrival floor, and (once the NV usage for that day is uploaded) the forecast day
// peak against the real one. Percentages here are percent, e.g. 12 = +12%.
import { PEAK_MARGIN } from './peakForecast.ts';

export interface PlannedDay {
  pct: number; kwh: number;
  aimKw: number | null;       // PEAK_MARGIN x the forecast day peak
  houseKw: number | null; roomKw: number | null;
}

export interface ScoreEntry {
  day: number;                // local day number
  date: string;               // YYYY-MM-DD
  plannedPct: number | null; plannedKwh: number | null;
  actualPct: number | null; actualKwh: number | null;
  useErrPct: number | null;   // (actual - planned) / planned x 100
  lowSocPct: number | null; short: boolean | null;
  fcPeakKw: number | null; fcRoomKw: number | null; fcHouseKw: number | null;
  peakKw: number | null; houseNightKw: number | null;   // what NV usage says that day
  peakErrPct: number | null;  // (actual - forecast day peak) / forecast x 100
  roomKw: number | null;      // actual room: PEAK_MARGIN x day peak - house night load
  peakScored: boolean;        // the NV usage for the day was in
}

export interface ScoreInput {
  day: number; date: string;
  planned: PlannedDay | null | undefined;
  actualPct: number | null;           // the daily-use log's used_pct (null = unknown day)
  lowSocPct: number | null;           // lowest SoC seen in that day's drives
  floorPct: number;
  peak: { dayKw: number | null; houseNightKw: number | null } | null;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function scoreDay(i: ScoreInput): ScoreEntry {
  const pl = i.planned && i.planned.pct > 0 ? i.planned : null;
  const actual = i.actualPct !== null && Number.isFinite(i.actualPct) ? i.actualPct : null;
  const fcPeak = i.planned?.aimKw != null ? i.planned.aimKw / PEAK_MARGIN : null;
  const pk = i.peak && i.peak.dayKw !== null && i.peak.houseNightKw !== null ? i.peak : null;
  return {
    day: i.day, date: i.date,
    plannedPct: pl ? r2(pl.pct) : null, plannedKwh: pl ? r2(pl.kwh) : null,
    actualPct: actual === null ? null : r2(actual),
    actualKwh: pl && actual !== null ? r2(actual * (pl.kwh / pl.pct)) : null,
    useErrPct: pl && actual !== null ? r2(((actual - pl.pct) / pl.pct) * 100) : null,
    lowSocPct: i.lowSocPct, short: i.lowSocPct === null ? null : i.lowSocPct < i.floorPct,
    fcPeakKw: fcPeak === null ? null : r2(fcPeak), fcRoomKw: i.planned?.roomKw ?? null, fcHouseKw: i.planned?.houseKw ?? null,
    peakKw: pk ? pk.dayKw : null, houseNightKw: pk ? pk.houseNightKw : null,
    peakErrPct: pk && fcPeak !== null && fcPeak > 0 ? r2((((pk.dayKw as number) - fcPeak) / fcPeak) * 100) : null,
    roomKw: pk ? r2(PEAK_MARGIN * (pk.dayKw as number) - (pk.houseNightKw as number)) : null,
    peakScored: pk !== null,
  };
}

export function medianOf(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export interface ScoreSummary {
  days: number;                     // days with a use error
  medianUseErrPct: number | null;
  shortDays: number;
  medianPeakErrPct: number | null;
  peakDays: number;
}

// Entries with from <= day <= to.
export function summarize(entries: ScoreEntry[], from: number, to: number): ScoreSummary {
  const w = entries.filter((e) => e.day >= from && e.day <= to);
  const use = w.flatMap((e) => (e.useErrPct === null ? [] : [e.useErrPct]));
  const peak = w.flatMap((e) => (e.peakErrPct === null ? [] : [e.peakErrPct]));
  return {
    days: use.length, medianUseErrPct: medianOf(use), shortDays: w.filter((e) => e.short === true).length,
    medianPeakErrPct: medianOf(peak), peakDays: peak.length,
  };
}

export const DRIFT_USE_ERR_PCT = 10;   // trailing median above this: the plan under-forecasts
export const DRIFT_MIN_DAYS = 3;       // scored days needed before the median counts
export const DRIFT_WINDOW_DAYS = 14;
export const SHORT_WINDOW_DAYS = 7;

// ISO 8601 week of a local day number, e.g. "2026-W46".
export function isoWeek(day: number): string {
  const d = new Date(day * 86_400_000);
  const dow = (d.getUTCDay() + 6) % 7;                       // Monday = 0
  const thu = new Date(d.getTime() + (3 - dow) * 86_400_000);
  const year = thu.getUTCFullYear();
  const week = Math.floor((thu.getTime() - Date.UTC(year, 0, 1)) / (7 * 86_400_000)) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export interface Drift { fire: boolean; week: string; message: string }

// At most one drift push per ISO week: the trailing 14-day median use error above +10%, or any
// short day in the last 7. Days before `today` count.
export function driftDecision(entries: ScoreEntry[], today: number, lastWeek: string | null): Drift {
  const week = isoWeek(today);
  const s14 = summarize(entries, today - DRIFT_WINDOW_DAYS, today - 1);
  const s7 = summarize(entries, today - SHORT_WINDOW_DAYS, today - 1);
  const reasons: string[] = [];
  if (s14.days >= DRIFT_MIN_DAYS && s14.medianUseErrPct !== null && s14.medianUseErrPct > DRIFT_USE_ERR_PCT) {
    reasons.push(`Real use ran ${Math.round(s14.medianUseErrPct)}% above the forecast over the last ${DRIFT_WINDOW_DAYS} days (median).`);
  }
  if (s7.shortDays > 0) {
    reasons.push(`${s7.shortDays} of the last ${SHORT_WINDOW_DAYS} days ended under the arrival floor.`);
  }
  return { fire: reasons.length > 0 && lastWeek !== week, week, message: reasons.join(' ') };
}
