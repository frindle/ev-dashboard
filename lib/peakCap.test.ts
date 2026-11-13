// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/peakCap.test.ts
// Made-up numbers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PEAK_CAP_START_DAY, ampsForNeed, capAmpsOf, capKwOf, dayTimeMs, nightPlan, nightWindow, peakCapDecision, peakCapOn,
  planTonight, type PeakCapInput, type PeakCapNight, type PeakCapSetup, type Shift,
} from './chargePlan.ts';
import { dayPeakForecast, nightHouseForecast, peakCapNight, weightedQuantile, type PeakDay } from './peakCap.ts';
import { backtestPeakCap, formatBacktest, type BacktestDay } from './peakCapBacktest.ts';
import { parsePeakCsv, buildPeakCapSetup } from './peakCapData.ts';
import { parseDaysCsv } from '../scripts/peak-cap-backtest.ts';

const day = (iso: string) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86_400_000);
const base = { limitPct: 70, margin: 1.1, floorPct: 25, kwhPerPct: 1.44, minAmps: 6, maxAmps: 48, windowHours: 8 };
const night = (peak: number | null, house: number | null, teslaKw = 0): PeakCapNight => ({ peakForecastKw: peak, houseNightKw: house, teslaKw });

test('gate: off by default, off before 2027-01-01 even when enabled', () => {
  assert.equal(PEAK_CAP_START_DAY, day('2027-01-01'));
  assert.equal(peakCapOn(undefined, day('2027-06-01')), false);
  assert.equal(peakCapOn(false, day('2027-06-01')), false);
  assert.equal(peakCapOn(true, day('2026-12-31')), false);
  assert.equal(peakCapOn(true, day('2027-01-01')), true);
});

test('cap math: 0.8 x forecast - house - Tesla, kW per amp 0.24, 2A steps rounded down', () => {
  assert.equal(capKwOf(night(5, 1.5)), 0.8 * 5 - 1.5);          // 2.5 kW
  assert.equal(capAmpsOf(2.5), 10);                               // 10.4 A -> 10
  assert.equal(capAmpsOf(0.24 * 13.9), 12);                       // 13.9 A -> 12, never up
  assert.equal(capAmpsOf(0.24 * 14), 14);
  assert.equal(capAmpsOf(0.1), 0);
  assert.equal(capAmpsOf(100, 48), 48);
  assert.equal(capKwOf(night(5, 1.5, 1.0)), 0.8 * 5 - 1.5 - 1.0); // the Tesla's planned kW comes out first
  assert.equal(capKwOf(night(1, 3)), 0);                          // never negative
  assert.equal(capKwOf(night(null, 1)), null);
  assert.equal(capKwOf(night(5, null)), null);
});

test('forecast: weighted median of similar days, p90 night load, too few days -> null with a reason', () => {
  assert.equal(weightedQuantile([{ v: 1, w: 1 }, { v: 2, w: 1 }, { v: 3, w: 1 }], 0.5), 2);
  assert.equal(weightedQuantile([{ v: 1, w: 1 }, { v: 2, w: 1 }, { v: 9, w: 0 }], 0.5), 1);
  assert.equal(weightedQuantile([], 0.5), null);
  const days: PeakDay[] = [];
  for (let i = 1; i <= 20; i++) days.push({ date: `2026-07-${String(i).padStart(2, '0')}`, dayKw: 4 + (i % 5) * 0.5, houseNightKw: 1 + (i % 10) * 0.1, isWork: i % 2 === 0, tempF: 100 });
  for (let i = 1; i <= 10; i++) days.push({ date: `2026-01-${String(i).padStart(2, '0')}`, dayKw: 20, houseNightKw: 9, isWork: true, tempF: 40 });
  const t = { month: 7, isWork: true, tempF: 101 };
  const f = dayPeakForecast(days, t);
  assert.ok(f.kw !== null && f.kw >= 4 && f.kw <= 6, `July forecast ignores the January days: ${f.kw}`);
  const h = nightHouseForecast(days, t);
  assert.ok(h.kw !== null && h.kw >= 1.5 && h.kw <= 2, `p90 of the July house load: ${h.kw}`);
  const few = dayPeakForecast(days.slice(0, 3), t);
  assert.equal(few.kw, null);
  assert.match(few.why!, /only \d+ similar days/);
  const n = peakCapNight(days.slice(0, 3), t);
  assert.equal(n.peakForecastKw, null);
  assert.ok(n.why);
});

const capOf = (tonight: PeakCapNight, ahead: Partial<{ n: PeakCapNight; needKwh: number; hours: number }>[] = []): PeakCapInput =>
  ({ tonight, ahead: ahead.map((a) => ({ ...(a.n ?? night(10, 1)), needKwh: a.needKwh ?? 10, hours: a.hours ?? 8 })) });

test('fits under the cap: charge at the cap amps (highest that fit), up to the limit', () => {
  // cap 0.8*5 - 1.5 = 2.5 kW -> 10 A; need 12 kWh = 1.5 kWh/h -> 8 A at 8 h fits
  const d = peakCapDecision({ kwh: 12, hours: 8, minAmps: 6, maxAmps: 48, cap: capOf(night(5, 1.5)), roomKwh: 100 });
  assert.equal(d.amps, 10);
  assert.ok(Math.abs(d.extraKwh - (10 * 0.24 * 8 - 12)) < 1e-9);   // 19.2 kWh delivered
  assert.equal(d.report.overKw, 0);
  assert.equal(d.report.fits, true);
  // the 70% limit bounds the extra
  const lim = peakCapDecision({ kwh: 12, hours: 8, minAmps: 6, maxAmps: 48, cap: capOf(night(5, 1.5)), roomKwh: 3 });
  assert.equal(lim.extraKwh, 3);
  assert.equal(ampsForNeed(12, 8, 6, 48, capOf(night(5, 1.5)), 100), 10);
});

test('does not fit: one night over, at the lowest amps that reach the target, over_kw reported', () => {
  // cap 0.8*3 - 1.5 = 0.9 kW -> 2 A, below the car's 6 A minimum: nothing fits. Need 24 kWh over 8 h = 12.5 -> 14 A
  const d = peakCapDecision({ kwh: 24, hours: 8, minAmps: 6, maxAmps: 48, cap: capOf(night(3, 1.5)), roomKwh: 50 });
  assert.equal(d.amps, 14);                      // the same amps today's plan picks
  assert.equal(d.extraKwh, 0);
  assert.equal(d.report.fits, false);
  assert.ok(Math.abs(d.report.overKw - (14 * 0.24 - 0.9)) < 1e-9);
  assert.equal(d.report.capAmps, 2);
  // a cap that could carry some amps but not enough: also over
  const part = peakCapDecision({ kwh: 40, hours: 8, minAmps: 6, maxAmps: 48, cap: capOf(night(5, 1.5)), roomKwh: 0 });
  assert.equal(part.amps, 22);                   // 40/1.92 = 20.8 -> 22 A
  assert.ok(part.report.overKw > 0);
});

test('one-night-over rule: when one of the next 2 nights would go over, tonight adds charge up to its own cap', () => {
  const tight = night(3, 1.5);   // cap 0.9 kW: that night cannot fit its 10 kWh
  const roomy = night(10, 1);
  // tonight has no need of its own; with a looming night it charges at its cap (6.4 kW -> 26 A is too much, use the cap of 5 / 1.5)
  const cap = capOf(night(5, 1.5), [{ n: roomy, needKwh: 4 }, { n: tight, needKwh: 10 }]);
  const d = peakCapDecision({ kwh: 0, hours: 8, minAmps: 6, maxAmps: 48, cap, roomKwh: 12 });
  assert.equal(d.amps, 10);
  assert.equal(d.extraKwh, 12);                  // bounded by the room under the limit
  // nobody goes over: no need and no looming night -> today's amps (min), no extra charge
  const calm = capOf(night(5, 1.5), [{ n: roomy, needKwh: 4 }, { n: roomy, needKwh: 4 }]);
  const c = peakCapDecision({ kwh: 0, hours: 8, minAmps: 6, maxAmps: 48, cap: calm, roomKwh: 12 });
  assert.equal(c.amps, 6);
  assert.equal(c.extraKwh, 0);
  // a night with no data never counts as over
  const nodata = capOf(night(5, 1.5), [{ n: night(null, null), needKwh: 50 }]);
  assert.equal(peakCapDecision({ kwh: 0, hours: 8, minAmps: 6, maxAmps: 48, cap: nodata, roomKwh: 12 }).extraKwh, 0);
});

test('Tesla subtraction lowers the cap', () => {
  const noTesla = peakCapDecision({ kwh: 6, hours: 8, minAmps: 6, maxAmps: 48, cap: capOf(night(5, 1.5, 0)), roomKwh: 0 });
  const tesla = peakCapDecision({ kwh: 6, hours: 8, minAmps: 6, maxAmps: 48, cap: capOf(night(5, 1.5, 1.2)), roomKwh: 0 });
  assert.equal(noTesla.report.capAmps, 10);
  assert.equal(tesla.report.capAmps, 4);        // (4 - 1.5 - 1.2) = 1.3 kW -> 5.4 A -> 4
  assert.equal(tesla.report.fits, false);       // below the car's 6 A minimum
});

test('no data for the night: today\'s amps and the reason', () => {
  const d = peakCapDecision({ kwh: 12, hours: 8, minAmps: 6, maxAmps: 48, cap: capOf({ peakForecastKw: null, houseNightKw: null, why: 'day peak: only 2 similar days uploaded (need 8)' }), roomKwh: 5 });
  assert.equal(d.amps, 8);
  assert.equal(d.extraKwh, 0);
  assert.equal(d.report.capAmps, null);
  assert.match(d.report.why!, /only 2 similar days/);
});

const D = day('2027-02-10');
const shifts: Shift[] = [];
const common = {
  day: D, shifts, workDays: new Set<number>(), usePctWork: 15.5, usePctOff: 8, socPct: 40, limitPct: 70,
  margin: 1.1, floorPct: 25, kwhPerPct: 1.44, minAmps: 6, maxAmps: 48,
};
const setup = (enabled: boolean, nights: [number, PeakCapNight][]): PeakCapSetup => ({ enabled, byDay: new Map(nights) });
const good = (d: number) => [d, night(6, 1.5)] as [number, PeakCapNight];

test('gate off = byte-identical plan; disabled setup, absent setup and null all equal today\'s output', () => {
  const today = JSON.stringify(planTonight(common));
  assert.equal(JSON.stringify(planTonight({ ...common, peakCap: null })), today);
  assert.equal(JSON.stringify(planTonight({ ...common, peakCap: setup(false, [good(D), good(D + 1), good(D + 2)]) })), today);
  assert.ok(!today.includes('peakCap'));
});

test('before 2027-01-01 = off, even when enabled', () => {
  const d0 = day('2026-12-20');
  const c = { ...common, day: d0 };
  const today = JSON.stringify(planTonight(c));
  assert.equal(JSON.stringify(planTonight({ ...c, peakCap: setup(true, [good(d0), good(d0 + 1), good(d0 + 2)]) })), today);
  // the first serve day on/after the start is capped
  const first = planTonight({ ...common, day: PEAK_CAP_START_DAY, peakCap: setup(true, [good(PEAK_CAP_START_DAY)]) });
  assert.ok(first.plan.peakCap);
});

test('enabled after the start: the plan carries the cap report and charges at the cap amps', () => {
  const r = planTonight({ ...common, peakCap: setup(true, [good(D), good(D + 1), good(D + 2)]) });
  // cap = 0.8*6 - 1.5 = 3.3 kW -> 13.75 A -> 12 A; the need (about 17% = 24 kWh over 8h = 12.8 -> 14 A) exceeds it: one night over
  const p = r.plan;
  assert.ok(p.peakCap);
  assert.equal(p.peakCap!.capAmps, 12);
  assert.equal(p.peakCap!.fits, false);
  assert.ok(p.peakCap!.overKw > 0);
  assert.equal(p.amps, planTonight(common).plan.amps);   // over: today's amps
  const small = planTonight({ ...common, usePctOff: 3, socPct: 62, peakCap: setup(true, [good(D), good(D + 1), good(D + 2)]) });
  assert.equal(small.plan.peakCap!.fits, true);
  assert.equal(small.plan.amps, 12);                      // the cap amps, not the lowest that reach the target
  assert.ok(small.plan.targetPct! <= 70 + 1e-9);          // never past the limit
  assert.ok(small.plan.kwh > planTonight({ ...common, usePctOff: 3, socPct: 62 }).plan.kwh);
});

test('DST night: 2027-03-14 has a 7 hour 00:00-08:00 window and the cap delivers over those hours', () => {
  const dst = day('2027-03-14');
  const w = nightWindow(dst, []);
  assert.ok(Math.abs(w.hours - 7) < 1e-9, `hours ${w.hours}`);
  assert.equal(dayTimeMs(dst, 8) - dayTimeMs(dst, 0), 7 * 3_600_000);
  const r = planTonight({ ...common, day: dst, usePctOff: 3, socPct: 62, peakCap: setup(true, [[dst, night(6, 1.5)], [dst + 1, night(6, 1.5)], [dst + 2, night(6, 1.5)]]) });
  assert.equal(r.plan.windowHours, 7);
  assert.equal(r.plan.amps, 12);
  assert.ok(r.plan.kwh <= 12 * 0.24 * 7 + 1e-9);          // 20.16 kWh at most in 7 hours
  const fall = day('2027-11-07');                          // the 25 hour day: 9 real hours between 00:00 and 08:00
  assert.ok(Math.abs(dayTimeMs(fall, 8) - dayTimeMs(fall, 0) - 9 * 3_600_000) < 1e-6);
});

test('2A rounding: odd cap amps never round up', () => {
  for (const [kw, amps] of [[0.24 * 6, 6], [0.24 * 7.99, 6], [0.24 * 8, 8], [0.24 * 9.5, 8], [0.24 * 47, 46]] as [number, number][]) {
    assert.equal(capAmpsOf(kw), amps, `${kw} kW`);
  }
});

test('buildPeakCapSetup: three nights, the serve day gets the forecast high', () => {
  const days: PeakDay[] = [];
  for (let i = 1; i <= 15; i++) days.push({ date: `2027-02-${String(i).padStart(2, '0')}`, dayKw: 4, houseNightKw: 1, isWork: null, tempF: 60 });
  const s = buildPeakCapSetup(true, D, days, null, 61);
  assert.deepEqual([...s.byDay.keys()], [D, D + 1, D + 2]);
  assert.equal(s.byDay.get(D)!.peakForecastKw, 4);
  assert.equal(buildPeakCapSetup(true, D, [], null, null).byDay.get(D)!.peakForecastKw, null);
});

test('Influx CSV rows parse into per-day figures', () => {
  const csv = [
    '#datatype,string,long,dateTime:RFC3339,double,double',
    ',result,table,_time,day_peak_kw,house_night_kw',
    ',_result,0,2027-02-10T20:00:00Z,4.5,1.25',
    ',_result,0,2027-02-11T20:00:00Z,,2',
    '',
  ].join('\n');
  const rows = parsePeakCsv(csv);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].date, rows[0].dayKw, rows[0].houseNightKw], ['2027-02-10', 4.5, 1.25]);
  assert.equal(rows[1].dayKw, null);
});

test('backtest: aggregates only; the cap removes nights where the car set the peak', () => {
  const days: BacktestDay[] = [];
  for (let i = 0; i < 40; i++) {
    const ev = i % 2 === 0 ? 4 : 0;
    days.push({
      date: `2027-02-${String(i % 28 + 1).padStart(2, '0')}`, dayKw: 4, houseNightKw: 1, isWork: i % 3 === 0, tempF: null,
      nightKw: 1 + ev, evKwAtNightPeak: ev,
    });
  }
  const r = backtestPeakCap(days);
  assert.equal(r.daysWithEv, 20);
  assert.equal(r.today.daysCarSetPeak, 20 - 0);          // 5 kW night vs a 4 kW day
  assert.ok(Math.abs(r.today.excessKwMax - 1) < 1e-9);
  assert.ok(r.median80.daysCarSetPeak < r.today.daysCarSetPeak);
  assert.ok(r.median80.usd < r.today.usd);
  const text = formatBacktest(r).join('\n');
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(text), 'no dates in the output');
  assert.match(text, /\$0\.14\/kW\/day/);
});

test('backtest CSV parser needs its columns', () => {
  const rows = parseDaysCsv('date,day_kw,night_kw,ev_kw_at_night_peak,house_night_kw,work\n2027-02-01,4,5,4,1,1\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].isWork, true);
  assert.throws(() => parseDaysCsv('date,day_kw\n2027-02-01,4\n'), /missing columns/);
});

test('nightPlan itself is unchanged without a cap input', () => {
  const p = nightPlan({ ...base, isWork: true, socPct: 50, usePct: 15.5 });
  assert.equal(p.amps, 14);
  assert.equal('peakCap' in p, false);
});
