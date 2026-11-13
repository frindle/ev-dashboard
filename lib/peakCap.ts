// Peak forecast for the EV peak cap (EV charge plan #9b, Rev 13). Pure: node:test loads it directly.
//
// Inputs are the per-day figures the NV usage upload (#9a) writes as nve_daily_peak: the day's
// highest 15-minute import between 08:00 and 24:00 (day_peak_kw) and the house load at the night's
// peak (house_night_kw, meter minus EV). Both forecasts are a similarity-weighted quantile of past
// days: the same month (and the neighbours), the same kind of day (work or off), and, when both sides
// have a temperature, a similar forecast high. That is a smooth curve against temperature, kind and
// month without a fitted model.
//   day peak    -> median (q 0.5); the cap then takes 80% of it (chargePlan.ts PEAK_CAP_MARGIN)
//   night house -> 90th percentile (a load that is too low is the costly miss)
// Too few similar days -> null with a reason; the cap stays off for that night.
import type { PeakCapNight } from './chargePlan.ts';

export const DAY_PEAK_QUANTILE = 0.5;
export const NIGHT_HOUSE_QUANTILE = 0.9;
export const MIN_SIMILAR_DAYS = 8;     // days with any weight
export const MIN_EFFECTIVE_WEIGHT = 5; // and this much total weight
export const TEMP_BANDWIDTH_F = 8;

export interface PeakDay {
  date: string;                 // local YYYY-MM-DD
  dayKw: number | null;         // 08:00-24:00 peak
  houseNightKw: number | null;  // night house load at the night peak
  isWork: boolean | null;
  tempF?: number | null;        // that day's high, when known
}
export interface PeakTarget { month: number; isWork: boolean | null; tempF?: number | null }   // month 1-12

export function monthOfDate(date: string): number { return Number(date.slice(5, 7)); }

export function similarity(d: PeakDay, t: PeakTarget): number {
  const dm = Math.abs(monthOfDate(d.date) - t.month);
  const mdist = Math.min(dm, 12 - dm);
  const wMonth = mdist === 0 ? 1 : mdist === 1 ? 0.5 : mdist === 2 ? 0.15 : 0;
  if (wMonth === 0) return 0;
  const wKind = d.isWork === null || t.isWork === null ? 0.5 : d.isWork === t.isWork ? 1 : 0.1;
  const hasTemp = typeof d.tempF === 'number' && typeof t.tempF === 'number';
  const wTemp = hasTemp ? Math.exp(-0.5 * (((d.tempF as number) - (t.tempF as number)) / TEMP_BANDWIDTH_F) ** 2) : 1;
  return wMonth * wKind * wTemp;
}

/** Lower weighted quantile (q in 0..1) of {v, w}. null when empty or all weights zero. */
export function weightedQuantile(items: { v: number; w: number }[], q: number): number | null {
  const xs = items.filter((i) => Number.isFinite(i.v) && i.w > 0).sort((a, b) => a.v - b.v);
  const total = xs.reduce((s, i) => s + i.w, 0);
  if (!xs.length || !(total > 0)) return null;
  let acc = 0;
  for (const i of xs) {
    acc += i.w;
    if (acc >= q * total - 1e-12) return i.v;
  }
  return xs[xs.length - 1].v;
}

export interface Forecast { kw: number | null; days: number; why: string | null }

function forecast(days: PeakDay[], t: PeakTarget, pick: (d: PeakDay) => number | null, q: number, label: string): Forecast {
  const items: { v: number; w: number }[] = [];
  for (const d of days) {
    const v = pick(d);
    if (v === null || !Number.isFinite(v)) continue;
    const w = similarity(d, t);
    if (w > 0) items.push({ v, w });
  }
  const total = items.reduce((s, i) => s + i.w, 0);
  if (items.length < MIN_SIMILAR_DAYS || total < MIN_EFFECTIVE_WEIGHT) {
    return { kw: null, days: items.length, why: `${label}: only ${items.length} similar days uploaded (need ${MIN_SIMILAR_DAYS})` };
  }
  return { kw: weightedQuantile(items, q), days: items.length, why: null };
}

export function dayPeakForecast(days: PeakDay[], t: PeakTarget, q = DAY_PEAK_QUANTILE): Forecast {
  return forecast(days, t, (d) => d.dayKw, q, 'day peak');
}
export function nightHouseForecast(days: PeakDay[], t: PeakTarget, q = NIGHT_HOUSE_QUANTILE): Forecast {
  return forecast(days, t, (d) => d.houseNightKw, q, 'night house load');
}

/** The cap inputs for one night. */
export function peakCapNight(days: PeakDay[], t: PeakTarget, teslaKw = 0, dayQ = DAY_PEAK_QUANTILE): PeakCapNight {
  const peak = dayPeakForecast(days, t, dayQ);
  const house = nightHouseForecast(days, t);
  return { peakForecastKw: peak.kw, houseNightKw: house.kw, teslaKw, why: peak.why ?? house.why ?? undefined };
}
