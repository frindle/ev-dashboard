// NV Energy usage import (EV charge plan #9a). Parses the interval CSV
// (15-minute kWh, channel 1 delivered / channel 3 received) and the demand CSV
// (channel 5, kW), builds nve_interval and nve_daily_peak Influx lines.
// Name, address, account, customer, premise and meter columns are never read
// into anything: the file parser picks the handful of columns it needs by
// header name and discards every other cell as the row goes by.
import { createCsvParser, type CsvParser } from './csv.ts';
import { pacificFields, pacificToMs, parseTimestamp } from './pacificTime.ts';

export const INTERVAL_MEASUREMENT = 'nve_interval';
export const DAILY_PEAK_MEASUREMENT = 'nve_daily_peak';
const MAX_GAP_DATES = 60;

export interface NveInterval {
  startMs: number;          // UTC interval start
  importKwh: number | null;
  exportKwh: number | null;
  importKw: number | null;
  estimated: boolean;
}

export interface NveAccumulator {
  byStart: Map<number, NveInterval>;
  intervalMin: number | null;
  files: { interval: number; demand: number };
  rows: number;
  ignoredRows: number;      // other channels, blank or non-numeric values
  intervalDates: Set<string>;   // local dates seen in the interval files
}

export function createAccumulator(): NveAccumulator {
  return { byStart: new Map(), intervalMin: null, files: { interval: 0, demand: 0 }, rows: 0, ignoredRows: 0, intervalDates: new Set() };
}

type Kind = 'interval' | 'demand';

// One parser per file. Feed chunks of text, call end(); rows land in `acc`.
export function createNveFileParser(acc: NveAccumulator): CsvParser {
  let kind: Kind | null = null;
  let iCh = -1, iStart = -1, iStatus = -1, iVal = -1, iLen = -1;
  const seen = new Map<string, number>();   // channel|startTime -> times seen (fall-back repeats)

  const onRow = (f: string[]) => {
    if (kind === null) {
      const h = f.map((x) => x.trim().toLowerCase());
      iCh = h.indexOf('channelnumber');
      iStart = h.indexOf('starttime');
      iLen = h.indexOf('intervallength');
      if (iCh >= 0 && iStart >= 0 && h.indexOf('usage') >= 0) {
        kind = 'interval'; iVal = h.indexOf('usage'); iStatus = h.indexOf('read type');
      } else if (iCh >= 0 && iStart >= 0 && h.indexOf('value') >= 0) {
        kind = 'demand'; iVal = h.indexOf('value'); iStatus = h.indexOf('readingstatuscode');
      } else {
        throw new Error('not an NV Energy interval or demand file (header not recognised)');
      }
      if (iStatus < 0) throw new Error('status column (Read Type / readingStatusCode) not found');
      acc.files[kind]++;
      return;
    }
    acc.rows++;
    const ch = (f[iCh] ?? '').trim();
    const field = kind === 'interval' ? (ch === '1' ? 'importKwh' : ch === '3' ? 'exportKwh' : null) : (ch === '5' ? 'importKw' : null);
    const raw = (f[iVal] ?? '').trim();
    const value = raw === '' ? NaN : Number(raw);
    if (!field || !Number.isFinite(value)) { acc.ignoredRows++; return; }

    const startText = (f[iStart] ?? '').trim();
    const key = ch + '|' + startText;
    const occ = seen.get(key) ?? 0;
    seen.set(key, occ + 1);
    const ms = parseTimestamp(startText, occ > 0 ? 1 : 0);
    if (kind === 'interval') acc.intervalDates.add(pacificFields(ms).date);

    if (acc.intervalMin === null && iLen >= 0) {
      const m = /^PT(\d+)M$/i.exec((f[iLen] ?? '').trim());
      if (m) acc.intervalMin = Number(m[1]);
    }
    let rec = acc.byStart.get(ms);
    if (!rec) { rec = { startMs: ms, importKwh: null, exportKwh: null, importKw: null, estimated: false }; acc.byStart.set(ms, rec); }
    rec[field] = value;
    if (/^calculated$/i.test((f[iStatus] ?? '').trim())) rec.estimated = true;
  };

  const csv = createCsvParser(onRow);
  return { push: (c) => csv.push(c), end: () => { csv.end(); if (kind === null) throw new Error('empty file'); } };
}

export function intervalMinutes(acc: NveAccumulator): number { return acc.intervalMin ?? 15; }

// Effective demand for an interval: the meter's own kW reading when the demand
// file covers it, otherwise kWh scaled to an hourly rate.
function kwOf(r: NveInterval, min: number): number | null {
  return r.importKw ?? (r.importKwh !== null ? r.importKwh * 60 / min : null);
}

export function sortedIntervals(acc: NveAccumulator): NveInterval[] {
  return [...acc.byStart.values()].sort((a, b) => a.startMs - b.startMs);
}

const hhmm = (ms: number) => { const p = pacificFields(ms); return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`; };

function datesBetween(a: string, b: string): string[] {
  const out: string[] = [];
  let t = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  const end = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
  for (; t <= end; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export interface NveSummary {
  files: { interval: number; demand: number };
  rows: number; ignoredRows: number;
  from: string | null; to: string | null;       // local dates
  intervals: number; estimated: number;
  importIntervals: number; exportIntervals: number; demandIntervals: number;
  missingDays: string[]; missingDayCount: number;
  peak: { kw: number; at: string } | null;      // local 'YYYY-MM-DD HH:MM'
}

export function summarize(acc: NveAccumulator): NveSummary {
  const list = sortedIntervals(acc);
  const min = intervalMinutes(acc);
  let peak: NveSummary['peak'] = null;
  let estimated = 0, imp = 0, exp = 0, dem = 0;
  for (const r of list) {
    if (r.estimated) estimated++;
    if (r.importKwh !== null) imp++;
    if (r.exportKwh !== null) exp++;
    if (r.importKw !== null) dem++;
    const kw = kwOf(r, min);
    if (kw !== null && (!peak || kw > peak.kw)) { const p = pacificFields(r.startMs); peak = { kw, at: `${p.date} ${hhmm(r.startMs)}` }; }
  }
  // Day-gap detection runs on the interval files; with demand only, on the demand dates.
  const dates = acc.intervalDates.size ? [...acc.intervalDates].sort() : [...new Set(list.map((r) => pacificFields(r.startMs).date))].sort();
  const have = new Set(dates);
  const missing = dates.length ? datesBetween(dates[0], dates[dates.length - 1]).filter((d) => !have.has(d)) : [];
  return {
    files: acc.files, rows: acc.rows, ignoredRows: acc.ignoredRows,
    from: dates[0] ?? null, to: dates[dates.length - 1] ?? null,
    intervals: list.length, estimated, importIntervals: imp, exportIntervals: exp, demandIntervals: dem,
    missingDays: missing.slice(0, MAX_GAP_DATES), missingDayCount: missing.length, peak,
  };
}

const num = (x: number) => String(Math.round(x * 1e6) / 1e6);

export function intervalLines(list: NveInterval[]): string[] {
  const out: string[] = [];
  for (const r of list) {
    const f: string[] = [];
    if (r.importKwh !== null) f.push(`import_kwh=${num(r.importKwh)}`);
    if (r.exportKwh !== null) f.push(`export_kwh=${num(r.exportKwh)}`);
    if (r.importKw !== null) f.push(`import_kw=${num(r.importKw)}`);
    if (f.length) out.push(`${INTERVAL_MEASUREMENT},estimated=${r.estimated} ${f.join(',')} ${r.startMs}`);
  }
  return out;
}

export interface SessionSpan { startMs: number; endMs: number; kw: number }

// Charge sessions as constant-power spans (avg kW when logged, else energy over time).
export function sessionSpans(rows: { startedAt: string; endedAt: string; durationMin: number; energyKwh: number; avgKw?: number }[]): SessionSpan[] {
  const out: SessionSpan[] = [];
  for (const r of rows) {
    const s = Date.parse(r.startedAt), e = Date.parse(r.endedAt);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    const kw = typeof r.avgKw === 'number' && r.avgKw > 0 ? r.avgKw : r.energyKwh / ((e - s) / 3_600_000);
    if (Number.isFinite(kw) && kw > 0) out.push({ startMs: s, endMs: e, kw });
  }
  return out;
}

// Average EV kW over one interval from every overlapping session.
export function evKwDuring(startMs: number, min: number, spans: SessionSpan[]): number {
  const endMs = startMs + min * 60_000;
  let kw = 0;
  for (const s of spans) {
    const o = Math.min(endMs, s.endMs) - Math.max(startMs, s.startMs);
    if (o > 0) kw += s.kw * o / (endMs - startMs);
  }
  return kw;
}

export interface DailyPeak {
  date: string;
  intervals: number;
  peakKw: number; peakTime: string;
  dayKw: number | null; dayTime: string | null;       // 08:00-24:00
  nightKw: number | null; nightTime: string | null;   // 00:00-08:00
  evKwAtNightPeak: number | null;
  houseNightKw: number | null;                        // meter minus EV at the night peak
}

export function dailyPeaks(list: NveInterval[], min: number, spans: SessionSpan[]): DailyPeak[] {
  type Best = { kw: number; ms: number };
  const days = new Map<string, { n: number; all?: Best; day?: Best; night?: Best }>();
  for (const r of list) {
    const kw = kwOf(r, min);
    if (kw === null) continue;
    const p = pacificFields(r.startMs);
    const d = days.get(p.date) ?? { n: 0 };
    days.set(p.date, d);
    d.n++;
    const b = { kw, ms: r.startMs };
    if (!d.all || kw > d.all.kw) d.all = b;
    const slot = p.hour < 8 ? 'night' : 'day';
    if (!d[slot] || kw > d[slot]!.kw) d[slot] = b;
  }
  const out: DailyPeak[] = [];
  for (const date of [...days.keys()].sort()) {
    const d = days.get(date)!;
    const ev = d.night ? evKwDuring(d.night.ms, min, spans) : null;
    out.push({
      date, intervals: d.n,
      peakKw: d.all!.kw, peakTime: hhmm(d.all!.ms),
      dayKw: d.day?.kw ?? null, dayTime: d.day ? hhmm(d.day.ms) : null,
      nightKw: d.night?.kw ?? null, nightTime: d.night ? hhmm(d.night.ms) : null,
      evKwAtNightPeak: ev, houseNightKw: d.night && ev !== null ? d.night.kw - ev : null,
    });
  }
  return out;
}

// Timestamp: local noon of the day, like ev_daily_use.
export function dailyPeakLines(peaks: DailyPeak[]): string[] {
  const out: string[] = [];
  for (const p of peaks) {
    const [y, m, d] = p.date.split('-').map(Number);
    const ts = pacificToMs(y, m, d, 12, 0, 0);
    if (ts === null) continue;
    const f = [`peak_kw=${num(p.peakKw)}`, `peak_time="${p.peakTime}"`, `intervals=${p.intervals}`];
    if (p.dayKw !== null) f.push(`day_peak_kw=${num(p.dayKw)}`, `day_peak_time="${p.dayTime}"`);
    if (p.nightKw !== null) f.push(`night_peak_kw=${num(p.nightKw)}`, `night_peak_time="${p.nightTime}"`);
    if (p.evKwAtNightPeak !== null) f.push(`ev_kw_at_night_peak=${num(p.evKwAtNightPeak)}`);
    if (p.houseNightKw !== null) f.push(`house_night_kw=${num(p.houseNightKw)}`);
    out.push(`${DAILY_PEAK_MEASUREMENT} ${f.join(',')} ${ts}`);
  }
  return out;
}
