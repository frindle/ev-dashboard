// What a charging night can draw without setting the day's demand peak (EV plan Rev 18). Pure:
// node:test loads it directly.
//
// NV Energy bills each day's highest 15-minute grid draw. The line the plan aims to stay under is
// the day's peak outside the EV window (08:00-24:00, nve_daily_peak day_peak_kw) times the 20%
// margin (Rev 13). A night's room is that line minus the house's own load that night
// (house_night_kw, meter minus EV).
//
// The forecast is the spread of that room on past days like the coming one: the same month (and
// the neighbours), the same kind of day (work or off), and a similar high temperature (the day's
// recorded high vs the coming day's forecast high). Room is taken per day (that day's line minus
// that night's house), not as a low day-peak quantile minus a high house quantile: stacking those
// on top of the margin left no room on any night in the Rev 18 backtest. The 20% margin replaces a
// low quantile, as Rev 13 set out. Only nights covered by the charge log count (houseSince).

export const ROOM_QUANTILES = [0.1, 0.3, 0.5, 0.7, 0.9];
export const PEAK_MARGIN = 0.8;          // aim 20% under the day peak (Rev 13)
export const MIN_SIMILAR_DAYS = 8;
export const MIN_EFFECTIVE_WEIGHT = 5;
export const TEMP_BANDWIDTH_F = 8;

export interface PeakDay {
  date: string;                 // local YYYY-MM-DD
  dayKw: number | null;         // 08:00-24:00 peak
  houseNightKw: number | null;  // house load at the night peak (meter minus EV)
  isWork: boolean | null;
  tempF?: number | null;        // that day's high
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

/** Lower weighted quantile (q in 0..1). null when empty or all weights are zero. */
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

function weighted(days: PeakDay[], t: PeakTarget, pick: (d: PeakDay) => number | null): { v: number; w: number }[] {
  const out: { v: number; w: number }[] = [];
  for (const d of days) {
    const v = pick(d);
    if (v === null || !Number.isFinite(v)) continue;
    const w = similarity(d, t);
    if (w > 0) out.push({ v, w });
  }
  return out;
}

const enough = (items: { w: number }[]) =>
  items.length >= MIN_SIMILAR_DAYS && items.reduce((s, i) => s + i.w, 0) >= MIN_EFFECTIVE_WEIGHT;

export interface NightForecast {
  aimKw: number | null;      // margin x the median similar day peak: the line tonight aims to stay under
  houseKw: number | null;    // the median similar night's house load
  headroomKw: number[];      // room under the line at ROOM_QUANTILES (equal-weight scenarios); [] = unknown
  days: number;              // similar days behind the room forecast
  why: string | null;        // why there is no forecast
}

// houseSince (YYYY-MM-DD): nights before it are left out. Before the charge log starts, the
// meter's night load still includes the cars.
export function nightForecast(days: PeakDay[], t: PeakTarget, houseSince: string | null = null): NightForecast {
  const logged = houseSince ? days.filter((d) => d.date >= houseSince) : days;
  const both = logged.filter((d) => d.dayKw !== null && d.houseNightKw !== null);
  const room = weighted(both, t, (d) => PEAK_MARGIN * (d.dayKw as number) - (d.houseNightKw as number));
  if (!enough(room)) {
    const peaks = weighted(days, t, (d) => d.dayKw);
    const why = enough(peaks)
      ? `only ${room.length} similar nights since the charge log started (need ${MIN_SIMILAR_DAYS})`
      : `only ${peaks.length} similar days of NV usage (need ${MIN_SIMILAR_DAYS})`;
    return { aimKw: null, houseKw: null, headroomKw: [], days: room.length, why };
  }
  const aimKw = PEAK_MARGIN * (weightedQuantile(weighted(both, t, (d) => d.dayKw), 0.5) as number);
  const houseKw = weightedQuantile(weighted(both, t, (d) => d.houseNightKw), 0.5) as number;
  return { aimKw, houseKw, headroomKw: ROOM_QUANTILES.map((q) => weightedQuantile(room, q) as number), days: room.length, why: null };
}
