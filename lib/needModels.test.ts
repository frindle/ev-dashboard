// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/needModels.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNeedData, coverageOk, curveValue, ewmaNeed, fitTempCurve, liveNeed, miPerPctAt, modelA, modelB, offDayNeed, overridesFromPass1, planNeed, refitDateFor,
  ruleFromShorts, simulate, tempNeed, walkDates, windowHoursFor, type DailyUse, type DriveIn,
} from './needModels.ts';
import { ampsFor, nightPlan } from './chargePlan.ts';

const d0 = Date.UTC(2026, 5, 1);
const date = (i: number) => new Date(d0 + i * 86_400_000).toISOString().slice(0, 10);
const row = (i: number, used: number | null, extra: Partial<DailyUse> = {}): DailyUse => ({
  date: date(i), unknown: used === null, used_pct: used, drive_pct: used, parked_pct: 1, drives: 2, miles: 40, ...extra,
});
// local-noon ISO for day i (PST/PDT both land inside the same local day)
const iso = (i: number, h = 12) => new Date(Date.UTC(2026, 5, 1 + i, h + 8)).toISOString();
const drive = (i: number, miles: number, drop: number, temp: number | null): DriveIn => ({
  start: iso(i), end: iso(i, 13), start_soc: 80, end_soc: 80 - drop, miles, temp_f: temp,
});
const trueCurve = (t: number) => 2.8 - 0.00015 * (t - 70) ** 2;   // mi/% , peaks mid-range

test('ewmaNeed: half-life weighting and kind fallback', () => {
  // work days (even i) used 10 long ago, 30 recently; 30-day half-life
  const rows: DailyUse[] = [], work: string[] = [];
  for (let i = 0; i < 60; i++) { rows.push(row(i, i < 30 ? 10 : 30)); work.push(date(i)); }
  const data = buildNeedData(rows, [], work);
  const e = ewmaNeed(data, date(60), true)!;
  assert.equal(e.source, 'kind');
  let s = 0, w = 0;
  for (let i = 0; i < 60; i++) { const wt = 0.5 ** ((60 - i) / 30); s += wt * (i < 30 ? 10 : 30); w += wt; }
  assert.ok(Math.abs(e.pct - s / w) < 1e-9);
  assert.ok(e.pct > 20 && e.pct < 30);
  // only 3 off days: falls back to the all-days mean (7-day half-life), not the 3 off days
  const rows2 = [row(0, 10), row(1, 10), row(2, 10), row(3, 40), row(4, 40), row(5, 40), row(6, 40)];
  const d2 = buildNeedData(rows2, [], [date(3), date(4), date(5), date(6)]);
  const off = ewmaNeed(d2, date(7), false)!;
  assert.equal(off.source, 'all');
  assert.ok(off.pct > 25 && off.pct < 40);
  assert.equal(ewmaNeed(buildNeedData([row(0, null)], [], []), date(5), false), null);
});

test('fitTempCurve recovers a known synthetic curve', () => {
  const drives: DriveIn[] = [];
  for (let i = 0; i < 120; i++) {
    const t = 35 + (i * 7) % 65;                       // 35..99F
    const drop = 6 + (i % 5);
    drives.push(drive(i % 60, trueCurve(t) * drop, drop, t));
  }
  const rows = Array.from({ length: 60 }, (_, i) => row(i, 15));
  const data = buildNeedData(rows, drives, []);
  const curve = fitTempCurve(data, '9999-12-31')!;
  assert.ok(curve);
  for (const t of [40, 55, 70, 85, 95]) {
    const got = curveValue(curve, t);
    assert.ok(Math.abs(got - trueCurve(t)) < 0.15, `${t}: ${got} vs ${trueCurve(t)}`);
  }
  // an outlier drive barely moves it (Huber)
  const noisy = buildNeedData(rows, [...drives, drive(5, 90, 3, 70)], []);
  assert.ok(Math.abs(curveValue(fitTempCurve(noisy, '9999-12-31')!, 70) - trueCurve(70)) < 0.2);
  // short / tiny drives are dropped, too few drives -> null
  assert.equal(fitTempCurve(buildNeedData(rows, [drive(0, 2, 1, 70)], []), '9999-12-31'), null);
});

test('sparse band uses 1.95, override map applies, curve elsewhere', () => {
  const drives: DriveIn[] = [], work: string[] = [];
  for (let i = 0; i < 40; i++) { work.push(date(i)); drives.push(drive(i, 3.0 * 8, 8, 70 + (i % 8))); }   // 70s band: 40 work drives at 3.0
  for (let i = 0; i < 12; i++) { drives.push(drive(40 + i, 2.6 * 8, 8, 55 + (i % 5))); }                  // 50s band: non-work drives only
  for (let i = 0; i < 10; i++) drives.push(drive(60 + i, 2.5 * 8, 8, 95 + (i % 3)));                       // too few work drives at 90s
  const rows = Array.from({ length: 80 }, (_, i) => row(i, 15));
  const data = buildNeedData(rows, drives, work);
  const curve = fitTempCurve(data, '9999-12-31')!;
  const plain = miPerPctAt(curve, 72);
  assert.equal(plain.source, 'curve');
  const sparse = miPerPctAt(curve, 55);
  assert.equal(sparse.source, 'sparse');
  assert.ok(sparse.value <= 1.95 + 1e-9);
  // override with a spread band
  const drives2: DriveIn[] = [];
  for (let i = 0; i < 40; i++) drives2.push(drive(i, (i % 2 ? 2.0 : 3.0) * 8, 8, 70 + (i % 8)));
  const d2 = buildNeedData(rows, drives2, work);
  const c2 = fitTempCurve(d2, '9999-12-31')!;
  const ov = miPerPctAt(c2, 72, new Map([[70, 0.25]]));
  assert.equal(ov.source, 'override');
  assert.ok(Math.abs(ov.value - 2.0) < 1e-9, String(ov.value));
  assert.ok(miPerPctAt(c2, 72).value > ov.value);
});

test('planNeed: null under 5-of-7 coverage; work day b, max rule, off day off-avg', () => {
  const rows: DailyUse[] = [], work: string[] = [], drives: DriveIn[] = [];
  for (let i = 0; i < 40; i++) {
    const isWork = i % 7 < 5;
    rows.push(row(i, isWork ? 18 : 8, { miles: isWork ? 40 : 5 }));
    if (isWork) work.push(date(i));
    drives.push(drive(i, 3 * 8, 8, 60 + (i % 20)));
  }
  const data = buildNeedData(rows, drives, work);
  const curve = fitTempCurve(data, date(35))!;
  assert.ok(coverageOk(data, date(35)));
  const wd = planNeed(data, date(35), curve, undefined)!;      // i=35 -> 35%7=0, a work day
  assert.equal(wd.rule, 'b');
  assert.ok(wd.pct > 10 && wd.pct < 30);
  const mx = planNeed(data, date(35), curve, undefined, { workDay: 'max' })!;
  assert.ok(mx.pct >= wd.pct && mx.rule === 'max');
  const off = planNeed(data, date(40), curve, undefined)!;     // 40%7=5, off
  assert.equal(off.rule, 'off-avg');
  // knock out 3 of the 7 days before day 38 -> 4 covered -> null
  const gappy = buildNeedData(rows.map((r, i) => (i >= 31 && i <= 33 ? { ...r, unknown: true, used_pct: null } : r)), drives, work);
  assert.equal(planNeed(gappy, date(38), curve, undefined), null);
  assert.equal(ruleFromShorts(3, 5).workDay, 'max');
  assert.equal(ruleFromShorts(5, 3).workDay, 'b');
});

test('walk-forward never uses future data', () => {
  const build = (spike: boolean, cut: number | null) => {
    const rows: DailyUse[] = [], work: string[] = [], drives: DriveIn[] = [];
    const n = cut ?? 60;
    for (let i = 0; i < n; i++) {
      const isWork = i % 7 < 5;
      const big = spike && i > 40;
      rows.push(row(i, big ? 90 : isWork ? 18 : 8, { miles: big ? 300 : isWork ? 40 : 5 }));
      if (isWork) work.push(date(i));
      drives.push(drive(i, (big ? 1 : 3) * 8, 8, big ? 20 : 60 + (i % 20)));
    }
    return buildNeedData(rows, drives, work);
  };
  const D = 40;
  for (const mk of [(s: boolean) => build(s, null), (s: boolean) => build(s, D + 1)]) void mk;
  const clean = build(false, D + 1), spiked = build(true, null);   // spike starts at day 41, after D
  const predict = (data: ReturnType<typeof build>, i: number) => {
    const curve = fitTempCurve(data, refitDateFor(date(14), date(i)));
    return planNeed(data, date(i), curve, undefined);
  };
  for (let i = 15; i <= D; i++) assert.deepEqual(predict(spiked, i), predict(clean, i), `day ${i}`);
  // sim: spiked days only change days from 41 on
  const a1 = simulate(clean, modelB(clean)), a2 = simulate(spiked, modelB(spiked));
  for (const d of a1.filter((x) => x.date <= date(D))) assert.deepEqual(a2.find((x) => x.date === d.date), d);
  // D's own used_pct is the answer, never an input
  const alt = buildNeedData(clean.rows.map((r) => (r.date === date(D) ? { ...r, used_pct: 99 } : r)), [], [...clean.workDays]);
  assert.deepEqual(ewmaNeed(alt, date(D), false), ewmaNeed(clean, date(D), false));
});

test('simulate: short-morning counting on a 5-day hand-computed case', () => {
  // history of constant 10% (off days, none are work days), then 5 scored days
  const used = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, /* scored: */ 10, 10, 30, 10, 10];
  const rows = used.map((u, i) => row(i, u));
  const data = buildNeedData(rows, [], []);
  assert.equal(walkDates(data).length, 5);
  const days = simulate(data, modelA(data), { limit: 70, floor: 25, kwhPerPct: 1.44, margin: 1 });
  assert.equal(days.length, 5);
  // need = 10 each day. chain starts at arrival=floor=25.
  // d1: morning max(25, 35)=35, arrive 25, charged 10 -> 14.4 kWh
  // d2: same. d3: morning 35, uses 30 -> arrive 5 -> SHORT
  // d4: morning max(5, 35)=35 charged 30 -> 43.2 kWh, arrive 25. d5: morning 35, arrive 25
  assert.deepEqual(days.map((d) => d.short), [false, false, true, false, false]);
  assert.deepEqual(days.map((d) => d.amps), [
    ampsFor(14.4, 0, 48, 8), ampsFor(14.4, 0, 48, 8), ampsFor(14.4, 0, 48, 8), ampsFor(43.2, 0, 48, 8), ampsFor(14.4, 0, 48, 8),
  ]);
  assert.deepEqual(days.map((d) => d.amps), [8, 8, 8, 24, 8]);
  assert.equal(days.filter((d) => d.nudge).length, 0);
  // a low limit forces nudges: floor 25 + 10 > 30
  const nudged = simulate(data, modelA(data), { limit: 30, floor: 25, margin: 1 });
  assert.equal(nudged.filter((d) => d.nudge).length, 5);
  assert.equal(windowHoursFor(date(3), true), 8);
  assert.equal(windowHoursFor(date(3), false), 8);
  // pass-1 override selection: band missing > 10% with enough days
  const fake = Array.from({ length: 10 }, (_, i) => ({ date: date(i), isWork: true, need: 1, actual: 1, short: i < 2, amps: 0, nudge: false, band: 70, source: '', morning: 0, arrival: 0 }));
  assert.deepEqual([...overridesFromPass1(fake).keys()], [70]);
  assert.equal(overridesFromPass1(fake.slice(0, 4)).size, 0);
});

test('tempNeed: commute / curve + parked (no margin; the planner applies it)', () => {
  const rows: DailyUse[] = [], work: string[] = [], drives: DriveIn[] = [];
  for (let i = 0; i < 30; i++) { rows.push(row(i, 15, { miles: 40, parked_pct: 2 })); work.push(date(i)); drives.push(drive(i, 3 * 8, 8, 70 + (i % 8))); }
  const data = buildNeedData(rows, drives, work);
  const curve = fitTempCurve(data, date(30))!;
  const need = tempNeed(data, date(30), curve)!;
  const v = miPerPctAt(curve, need.tempF).value;
  assert.ok(Math.abs(need.pct - (40 / v + 2)) < 1e-9);
  assert.ok(Math.abs(v - 3) < 0.05);
});

test('simulate reach mode applies the margin to the minimum', () => {
  const rows = Array.from({ length: 19 }, (_, i) => row(i, 10));
  const data = buildNeedData(rows, [], []);
  const days = simulate(data, modelA(data), { limit: 70, floor: 25 });   // default margin 1.1
  assert.ok(Math.abs(days[0].morning - 36) < 1e-9);                       // 25 + 10 x 1.1
  assert.ok(days.every((d) => !d.short));
});

test('simulate live mode follows nightPlan (reach target; the car runs the window to its limit)', () => {
  // 14 history days + 3 scored work days of 20%; scored day 15 is 95F (no heat cap with the floor)
  const rows: DailyUse[] = [], work: string[] = [], drives: DriveIn[] = [];
  for (let i = 0; i < 17; i++) { rows.push(row(i, 20)); work.push(date(i)); drives.push(drive(i, 40, 15, i === 15 ? 95 : 70)); }
  const data = buildNeedData(rows, drives, work);
  const live = simulate(data, modelA(data), { limit: 70, floor: 25, mode: 'live' });
  assert.equal(live.length, 3);
  // day 14: from 25%, need 20 -> reach 25 + 22 = 47 -> 18A; 8h at 18A puts in 24%, so the morning is 49
  const plan = (soc: number, use: number) => nightPlan({ isWork: true, socPct: soc, limitPct: 70, usePct: use, margin: 1.1, floorPct: 25, windowHours: 8, kwhPerPct: 1.44, minAmps: 8, maxAmps: 48 });
  const p0 = plan(25, live[0].need);
  assert.ok(Math.abs(live[0].morning - p0.endPct!) < 1e-9);
  assert.equal(live[0].amps, p0.amps);
  // day 15 starts where day 14 got home
  assert.ok(Math.abs(live[1].morning - plan(live[0].arrival, live[1].need).endPct!) < 1e-9);
  // a big need fills to the car's 70% limit, hot day or not
  const s2 = simulate(data, () => ({ pct: 40 }), { limit: 70, floor: 25, mode: 'live' });
  assert.ok(Math.abs(s2[0].morning - 70) < 1e-9);
  assert.ok(Math.abs(s2[1].morning - 70) < 1e-9);
  const s3 = simulate(data, () => ({ pct: 5 }), { limit: 70, floor: 25, mode: 'live' });
  // pct 5: reach 30.5; from 25 the need is 5.5% -> 8A minimum (Rivian's floor), 8h at 1.92 kW puts in 10.67% -> 35.67
  assert.ok(Math.abs(s3[0].morning - (25 + (8 * 240 * 8) / 1000 / 1.44)) < 1e-9);
  assert.ok(s3.every((d) => d.short));   // actual 20 > the planned 5.5 each day
});

test('liveNeed: null under 5-of-7 coverage; worst drive-time temperature wins; off day from (a)', () => {
  const rows: DailyUse[] = [], work: string[] = [], drives: DriveIn[] = [];
  for (let i = 0; i < 60; i++) {
    const isWork = i % 7 < 5;
    const t = [35, 50, 65][i % 3];                               // three well-filled bands (the fit needs 3 temps)
    rows.push(row(i, isWork ? 18 : 8, { miles: isWork ? 40 : 5 }));
    if (isWork) work.push(date(i));
    drives.push(drive(i, trueCurve(t) * 8, 8, t), drive(i, trueCurve(t) * 8, 8, t));
  }
  const mid = liveNeed(rows, drives, work, date(56), [65])!;      // 56%7=0, a work day
  assert.ok(mid && mid.work !== null && mid.off !== null);
  assert.equal(mid.tempF, 65);
  assert.equal(mid.workSource, 'curve');
  const both = liveNeed(rows, drives, work, date(56), [65, 35])!;
  assert.ok(both.work! > mid.work!);                              // 35F drives get fewer mi/%
  assert.equal(both.tempF, 35);
  const none = liveNeed(rows, drives, work, date(56), [])!;        // no forecast: curve at no temperature
  assert.ok(none && none.work !== null);
  const gappy = rows.map((r, i) => (i >= 51 && i <= 53 ? { ...r, unknown: true, used_pct: null } : r));
  assert.equal(liveNeed(gappy, drives, work, date(56), [65]), null);
});

test('offDayNeed: mean of recent days off without outliers, work days and old days ignored', () => {
  const rows: DailyUse[] = [], work: string[] = [];
  for (let i = 0; i < 140; i++) {
    const isWork = i % 7 < 4;
    if (isWork) work.push(date(i));
    // days off: 8,10,12 repeating; one 60% road trip and one 0% day sit outside the fences;
    // days off older than 90 days used 40 and must not count
    const off = i === 123 ? 60 : i === 125 ? 0 : 8 + 2 * (i % 3);
    rows.push(row(i, isWork ? 30 : i < 140 - 90 ? 40 : off));
  }
  const data = buildNeedData(rows, [], work);
  const o = offDayNeed(data, date(140))!;
  assert.equal(o.source, 'off-avg');
  assert.equal(o.dropped, 2);
  assert.ok(Math.abs(o.pct - 10) < 0.5, String(o.pct));
  // planNeed uses it for a day off
  const offDay = 144;                                          // 144 % 7 = 4: a day off
  const rows2 = [...rows, ...[140, 141, 142, 143].map((i) => row(i, 30))];
  const data2 = buildNeedData(rows2, [], [...work, date(140), date(141), date(142), date(143)]);
  const p2 = planNeed(data2, date(offDay), null, undefined)!;
  assert.equal(p2.rule, 'off-avg');
  assert.ok(Math.abs(p2.pct - offDayNeed(data2, date(offDay))!.pct) < 1e-9);
  // too few days off: the EWMA fallback
  const few = buildNeedData(rows.slice(0, 10), [], work);    // 3 days off
  assert.notEqual(offDayNeed(few, date(10))?.source, 'off-avg');
});

test('nightPlan: a day off with a floor uses the work-day buffers (reach = 25 + use x 1.1)', () => {
  const p = nightPlan({
    isWork: false, socPct: 30, limitPct: 70, usePct: 20, margin: 1.1, floorPct: 25, windowHours: 8,
    kwhPerPct: 1.44, minAmps: 6, maxAmps: 48,
  });
  assert.ok(Math.abs(p.needPct - (25 + 22 - 30)) < 1e-9);
  const q = nightPlan({
    isWork: false, socPct: null, limitPct: 70, usePct: 20, margin: 1.1, floorPct: 25, windowHours: 8,
    kwhPerPct: 1.44, minAmps: 6, maxAmps: 48,
  });
  assert.ok(Math.abs(q.needPct - 22) < 1e-9);
});
