// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/peakPlan.test.ts
// Demand-aware night planner (Rev 18): forecast of the room under the day peak, the per-night
// amps search, the data helpers, and how tonight's plan and the plug-in push use them. Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ampSteps, DEMAND_USD_PER_KW_DAY, KW_PER_AMP, morningOf, nightCostUsd, overKwOf, planNights, requiredMornings,
  type PeakPlanInput,
} from './peakPlan.ts';
import { nightForecast, similarity, weightedQuantile, type PeakDay } from './peakForecast.ts';
import { fillHighs, highLines, highsUrl, parseHighs, parsePeakCsv, peakNightsFor, roundCoord } from './peakData.ts';
import { planTonight, type Shift } from './chargePlan.ts';
import { arrivalPlugAlert, plugDecision } from './planAlerts.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
const night = (headroomKw: number[], hours = 8, usePct = 15) => ({ aimKw: 3, houseKw: 1, headroomKw, hours, usePct });
const input = (over: Partial<PeakPlanInput> = {}): PeakPlanInput => ({
  socPct: 30, limitPct: 70, floorPct: 25, margin: 1.1, kwhPerPct: 1.44, minAmps: 8, maxAmps: 48,
  nights: [night([]), night([]), night([])], ...over,
});

test('ampSteps: min to max in 2A steps, max always included', () => {
  const s = ampSteps(8, 48);
  assert.equal(s[0], 8);
  assert.equal(s[s.length - 1], 48);
  assert.equal(s.length, 21);
  assert.deepEqual(ampSteps(8, 13), [8, 10, 12, 13]);
});

test('nightCostUsd / overKwOf: only the draw above the room costs', () => {
  assert.equal(nightCostUsd(null, [0]), 0);
  assert.equal(nightCostUsd(8, [5]), 0);
  near(nightCostUsd(8, [1]), DEMAND_USD_PER_KW_DAY * (8 * KW_PER_AMP - 1));
  near(nightCostUsd(8, []), DEMAND_USD_PER_KW_DAY * 8 * KW_PER_AMP);
  near(nightCostUsd(8, [0, 1, 2]), (0.14 * 1.92 + 0.14 * 0.92 + 0) / 3);
  near(overKwOf(8, [0, 1, 2]), 0.92);
  assert.equal(overKwOf(8, [-3]), 1.92);   // negative room counts as none
});

test('morningOf: stops at the limit; no charge or no hours keeps the SoC', () => {
  near(morningOf(30, 8, 8, 70, 1.44), 30 + (8 * 0.24 * 8) / 1.44);
  assert.equal(morningOf(65, 48, 8, 70, 1.44), 70);
  assert.equal(morningOf(30, null, 8, 70, 1.44), 30);
  assert.equal(morningOf(30, 8, 0, 70, 1.44), 30);
});

test('requiredMornings: a short next night raises tonight\'s morning', () => {
  const r = requiredMornings(input({ nights: [night([], 8), night([], 0), night([], 8)] }));
  near(r[2], 41.5);
  near(r[1], 41.5);
  near(r[0], 58);   // night 1 can't charge: tomorrow's 41.5 plus a day's use x 1.1
});

test('planNights: free room under the line fills tonight at the highest free amps', () => {
  const c = planNights(input({ nights: [night([5, 5, 5]), night([5, 5, 5]), night([5, 5, 5])] }));
  assert.equal(c.amps[0], 20);   // 20A = 4.8 kW fits under 5 kW; 22A would not
  assert.equal(c.totalUsd, 0);
  assert.deepEqual(c.costUsd, [0, 0, 0]);
  assert.equal(c.shortPct, 0);
});

test('planNights: tomorrow covered and no room: tonight is skipped', () => {
  const c = planNights(input({ socPct: 65 }));
  assert.equal(c.amps[0], null);
  assert.equal(c.shortPct, 0);
  const need = 25 + 15 * 1.1;
  c.morningPct.forEach((m) => assert.ok(m >= need - 1e-6, `morning ${m}`));
});

test('planNights: every morning meets its need when it can', () => {
  for (const soc of [10, 25, 40, 55]) {
    for (const room of [[], [1], [0.5, 1, 1.5], [3, 4, 5]]) {
      const c = planNights(input({ socPct: soc, nights: [night(room), night(room), night(room)] }));
      assert.equal(c.shortPct, 0, `soc ${soc} room ${room}`);
      c.morningPct.forEach((m) => assert.ok(m >= 41.5 - 1e-6, `soc ${soc} room ${room}: morning ${m}`));
      c.amps.forEach((a) => assert.ok(a === null || (a >= 8 && a <= 48)));
    }
  }
});

test('planNights: when even 48A falls short, tonight runs at 48A and the gap is reported', () => {
  const c = planNights(input({ socPct: 0, nights: [night([], 8, 60), night([], 8, 60), night([], 8, 60)] }));
  assert.equal(c.amps[0], 48);
  assert.ok(c.shortPct > 0);
});

test('weightedQuantile: lower weighted quantile; empty is null', () => {
  const xs = [{ v: 1, w: 1 }, { v: 2, w: 1 }, { v: 3, w: 1 }, { v: 4, w: 1 }];
  assert.equal(weightedQuantile(xs, 0.5), 2);
  assert.equal(weightedQuantile(xs, 0.75), 3);
  assert.equal(weightedQuantile(xs, 1), 4);
  assert.equal(weightedQuantile([{ v: 9, w: 3 }, { v: 1, w: 1 }], 0.5), 9);
  assert.equal(weightedQuantile([], 0.5), null);
  assert.equal(weightedQuantile([{ v: 1, w: 0 }], 0.5), null);
});

test('similarity: month, kind of day and high temperature', () => {
  const d = (date: string, isWork: boolean | null, tempF: number | null = null): PeakDay => ({ date, dayKw: 3, houseNightKw: 1, isWork, tempF });
  assert.equal(similarity(d('2026-07-10', true), { month: 7, isWork: true }), 1);
  assert.equal(similarity(d('2026-01-10', true), { month: 7, isWork: true }), 0);
  assert.equal(similarity(d('2026-12-10', true), { month: 1, isWork: true }), 0.5);   // wraps the year
  assert.equal(similarity(d('2026-07-10', null), { month: 7, isWork: true }), 0.5);
  near(similarity(d('2026-07-10', true), { month: 7, isWork: false }), 0.1);
  near(similarity(d('2026-07-10', true, 100), { month: 7, isWork: true, tempF: 108 }), Math.exp(-0.5));
  assert.equal(similarity(d('2026-07-10', true, null), { month: 7, isWork: true, tempF: 108 }), 1);
});

test('nightForecast: room per night (margin x day peak minus that night house) at five quantiles; houseSince drops older nights', () => {
  const days: PeakDay[] = [];
  for (let i = 1; i <= 20; i++) {
    days.push({ date: `2026-07-${String(i).padStart(2, '0')}`, dayKw: i, houseNightKw: i <= 10 ? 9 : 1, isWork: true, tempF: 100 });
  }
  const f = nightForecast(days, { month: 7, isWork: true, tempF: 100 }, '2026-07-11');
  assert.equal(f.why, null);
  assert.equal(f.houseKw, 1);   // the cars-in-the-meter nights before the 11th are left out
  assert.equal(f.days, 10);
  near(f.aimKw as number, 0.8 * 15);   // median of the 11th-20th
  assert.equal(f.headroomKw.length, 5);
  near(f.headroomKw[0], 0.8 * 11 - 1);
  near(f.headroomKw[2], 0.8 * 15 - 1);
  near(f.headroomKw[4], 0.8 * 19 - 1);
  // room is paired per night: a high-peak day with a high house night is not "high peak, low house"
  const paired: PeakDay[] = [];
  for (let i = 1; i <= 10; i++) paired.push({ date: `2026-07-${String(i).padStart(2, '0')}`, dayKw: i % 2 ? 10 : 5, houseNightKw: i % 2 ? 8 : 3, isWork: true });
  const g = nightForecast(paired, { month: 7, isWork: true });
  for (const h of g.headroomKw) assert.ok(h <= 0.8 * 10 - 8 + 1e-9 || Math.abs(h - (0.8 * 5 - 3)) < 1e-9);
  const thin = nightForecast(days.slice(0, 5), { month: 7, isWork: true });
  assert.deepEqual(thin.headroomKw, []);
  assert.match(thin.why as string, /only 5 similar days/);
  const noHouse = nightForecast(days, { month: 7, isWork: true }, '2026-08-01');
  assert.deepEqual(noHouse.headroomKw, []);
  assert.match(noHouse.why as string, /since the charge log started/);
});

const CSV = [
  '#datatype,string,long,dateTime:RFC3339,dateTime:RFC3339,dateTime:RFC3339,string,double,double,double',
  ',result,table,_start,_stop,_time,_measurement,day_peak_kw,high_f,house_night_kw',
  ',_result,0,2025-01-01T00:00:00Z,2026-11-12T00:00:00Z,2026-07-01T19:00:00Z,nve_daily_peak,4.2,104.5,0.9',
  ',_result,0,2025-01-01T00:00:00Z,2026-11-12T00:00:00Z,2026-07-02T19:00:00Z,nve_daily_peak,3.8,,1.1',
  '',
].join('\n');

test('parsePeakCsv: pivoted Flux rows to local days; a missing high is null', () => {
  const rows = parsePeakCsv(CSV);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { ms: Date.parse('2026-07-01T19:00:00Z'), date: '2026-07-01', dayKw: 4.2, houseNightKw: 0.9, tempF: 104.5 });
  assert.equal(rows[1].tempF, null);
  assert.equal(rows[1].date, '2026-07-02');
});

test('archive helpers: coordinates rounded to 0.1 degree, null highs skipped, lines at the row time', () => {
  assert.equal(roundCoord(36.1749), 36.2);
  assert.equal(roundCoord(-115.1372), -115.1);
  const u = highsUrl(36.1749, -115.1372, '2026-07-01', '2026-07-02');
  assert.match(u, /latitude=36\.2&longitude=-115\.1&start_date=2026-07-01&end_date=2026-07-02/);
  assert.match(u, /temperature_unit=fahrenheit/);
  assert.doesNotMatch(u, /36\.17/);
  const h = parseHighs({ daily: { time: ['2026-07-01', '2026-07-02'], temperature_2m_max: [104.2, null] } });
  assert.deepEqual([...h], [['2026-07-01', 104.2]]);
  assert.equal(parseHighs(null).size, 0);
  assert.deepEqual(highLines([{ ms: 123, tempF: 101.26 }]), ['nve_daily_peak high_f=101.3 123']);
});

test('fillHighs: asks the archive once for the missing days and writes the highs back', async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fake = async (url: string, init: { method: string; body?: string }) => {
    calls.push({ url, method: init.method, body: init.body });
    if (url.includes('archive-api')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ daily: { time: ['2026-07-02'], temperature_2m_max: [99.4] } }) };
    }
    return { ok: true, status: 204, text: async () => '' };
  };
  const env = { INFLUX_URL: 'http://influx:8086', INFLUX_TOKEN: 't', INFLUX_ORG: 'home', INFLUX_BUCKET: 'metrics' };
  const rows = await fillHighs(parsePeakCsv(CSV), 36.17, -115.14, env, fake);
  assert.equal(rows[0].tempF, 104.5);
  assert.equal(rows[1].tempF, 99.4);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /start_date=2026-07-02&end_date=2026-07-02/);
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].body, `nve_daily_peak high_f=99.4 ${Date.parse('2026-07-02T19:00:00Z')}`);
  // Nothing missing, or no location: no calls.
  calls.length = 0;
  await fillHighs(rows, 36.17, -115.14, env, fake);
  await fillHighs(parsePeakCsv(CSV), null, null, env, fake);
  assert.equal(calls.length, 0);
});

test('peakNightsFor: three nights, each with its own day kind and high', () => {
  const days: PeakDay[] = [];
  for (let i = 1; i <= 30; i++) days.push({ date: `2026-07-${String(i).padStart(2, '0')}`, dayKw: i % 2 ? 5 : 3, houseNightKw: 1, isWork: i % 2 === 1, tempF: 100 });
  const serve = Math.round(Date.parse('2026-07-15T00:00:00Z') / 86_400_000);
  const n = peakNightsFor(days, serve, new Set([serve]), [100, null, null], '2026-07-01');
  assert.equal(n.length, 3);
  near(n[0].aimKw as number, 0.8 * 5);   // a work day like the odd days
  near(n[1].aimKw as number, 0.8 * 3);   // an off day
});

const D = Math.round(Date.parse('2026-07-15T00:00:00Z') / 86_400_000);
const tonightBase = {
  day: D, shifts: [] as Shift[], workDays: new Set([D, D + 1, D + 2]), usePctWork: 15, usePctOff: 10,
  limitPct: 70, margin: 1.1, floorPct: 25, kwhPerPct: 1.44, minAmps: 8, maxAmps: 48,
};

test('planTonight + peak: free room raises tonight; no peak input keeps the plain plan', () => {
  const plain = planTonight({ ...tonightBase, socPct: 35 });
  assert.equal(plain.plan.peak, undefined);
  assert.equal(plain.peakInput, null);
  const roomy = { aimKw: 6, houseKw: 1, headroomKw: [5, 5, 5] };
  const r = planTonight({ ...tonightBase, socPct: 35, peak: [roomy, roomy, roomy] });
  assert.ok(r.peakInput);
  assert.equal(r.plan.peak?.charge, true);
  assert.equal(r.plan.amps, 20);
  assert.ok((r.plan.amps as number) >= (plain.plan.amps ?? 0));
  assert.equal(r.plan.peak?.overKw, 0);
});

test('planTonight + peak: a covered night with no room holds the minimum and does not charge', () => {
  const tight = { aimKw: 2, houseKw: 2, headroomKw: [0, 0, 0] };
  const r = planTonight({ ...tonightBase, socPct: 66, peak: [tight, tight, tight] });
  assert.equal(r.plan.peak?.charge, false);
  assert.equal(r.plan.amps, 8);
  assert.equal(r.plan.endPct, 66);
});

test('plugDecision + arrival push: the peak reason', () => {
  const d = plugDecision({ socPct: 60, reachPct: 41.5, bufferPct: 0, override: null, peakCharge: true });
  assert.deepEqual(d, { needed: true, requiredPct: 41.5, reason: 'peak' });
  assert.equal(plugDecision({ socPct: 60, reachPct: 41.5, bufferPct: 0, override: null, peakCharge: false }).needed, false);
  assert.equal(plugDecision({ socPct: 30, reachPct: 41.5, bufferPct: 0, override: null, peakCharge: true }).reason, 'tomorrow');
  const now = Date.parse('2026-07-15T23:30:00-07:00');
  const a = arrivalPlugAlert({
    nowMs: now, today: D, sent: new Set(), shiftEndsMs: [now - 20 * 60_000], socPct: 60, decision: d, override: null,
    amps: 20, raiseLimitTo: null,
  });
  assert.equal(a?.title, 'Plug in the Rivian');
  assert.match(a?.message ?? '', /Tomorrow is covered \(needs 42%\), but charging tonight keeps the next nights under the demand peak\. Plan: 20A/);
});
