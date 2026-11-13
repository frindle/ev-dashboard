// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/nightPlan.test.ts
// The plan's "Examples" table (limit 70%, 1.44 kWh per 1%, 1A over 8h = 1.92 kWh).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ampsFor, dayTimeMs, historyStartMs, nightPlan, nightWindow, planTonight, sinceHistoryStart, topUpLimitFor,
  type Shift,
} from './chargePlan.ts';

const day = (iso: string) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86_400_000);
const D = day('2026-11-13');
const shift = (d: number, sh: number, sm: number, eh: number, em: number, uid?: string): Shift =>
  ({ day: d, startMs: dayTimeMs(d, sh, sm), endMs: dayTimeMs(d + (eh * 60 + em < sh * 60 + sm ? 1 : 0), eh, em), uid });

const base = { limitPct: 70, margin: 1.1, floorPct: 25, kwhPerPct: 1.44, minAmps: 6, maxAmps: 48, windowHours: 8 };
const USE = 15.5; // % per work day

test('ampsFor: hours argument, zero hours -> max', () => {
  assert.equal(ampsFor(1.92, 0, 48), 2);
  assert.equal(ampsFor(24.5, 6, 48), 14);
  assert.equal(ampsFor(10, 6, 48, 4), 12);
  assert.equal(ampsFor(10, 6, 48, 0), 48);
});

test('example: work night at 30% -> reach 42% -> 10A, the car ends near 43%', () => {
  const p = nightPlan({ ...base, isWork: true, socPct: 30, usePct: USE });
  assert.ok(Math.abs(p.needPct - 12.05) < 1e-9);
  assert.equal(p.amps, 10);
  assert.ok(Math.abs(p.targetPct! - 42.05) < 1e-9);
  assert.ok(Math.abs(p.endPct! - (30 + (10 * 0.24 * 8) / 1.44)) < 1e-9);
  assert.equal(p.shortfall, false);
});

test('example: work night at 50% is past the reach -> 6A minimum, the car stops at its limit', () => {
  const p = nightPlan({ ...base, isWork: true, socPct: 50, usePct: USE });
  assert.equal(p.needPct, 0);
  assert.equal(p.amps, 6);
  assert.equal(p.targetPct, 50);
  assert.ok(Math.abs(p.endPct! - 58) < 1e-9);
  const high = nightPlan({ ...base, isWork: true, socPct: 65, usePct: USE });
  assert.equal(high.endPct, 70);
});

test('example: work night at 20% must reach 42% -> 18A', () => {
  const p = nightPlan({ ...base, isWork: true, socPct: 20, usePct: USE });
  assert.ok(Math.abs(p.targetPct! - (25 + USE * 1.1)) < 1e-9);
  assert.ok(Math.abs(p.kwh - 31.7) < 0.1);
  assert.equal(p.amps, 18);
});

test('example: off night at 15%, day 10% -> reach 36% -> 16A', () => {
  const p = nightPlan({ ...base, isWork: false, socPct: 15, usePct: 10 });
  assert.ok(Math.abs(p.needPct - 21) < 1e-9);
  assert.equal(p.amps, 16);
});

test('example: late shift ends 00:30, 20% -> planned from 00:50 (7.2h) -> 20A', () => {
  const shifts = [shift(D - 1, 17, 0, 0, 30), shift(D, 14, 30, 23, 0)];
  const w = nightWindow(D, [shifts[0]]);
  assert.ok(Math.abs(w.hours - (8 - 50 / 60)) < 1e-9);
  const p = nightPlan({ ...base, isWork: true, socPct: 20, usePct: USE, windowHours: w.hours });
  assert.equal(p.amps, 20);
});

test('example: the night before that late shift adds about 3 kWh (+2A)', () => {
  const shifts = [shift(D, 17, 0, 0, 30)];
  const next = nightWindow(D + 1, [{ ...shifts[0], day: D }]);
  assert.ok(next.hours < 8 && next.hours > 7);
  const own = nightPlan({ ...base, isWork: true, socPct: 30, usePct: USE });
  const withNext = nightPlan({ ...base, isWork: true, socPct: 30, usePct: USE, next: { hours: next.hours, usePct: USE, isWork: true } });
  assert.ok(withNext.bufferPct > 1.5 && withNext.bufferPct < 2.5);
  assert.ok(Math.abs((withNext.kwh - own.kwh) - 3) < 0.6);
  assert.equal(withNext.amps! - own.amps!, 2);
});

test('short-night buffer is bounded by the limit room', () => {
  const p = nightPlan({ ...base, isWork: false, socPct: 69, usePct: 1, next: { hours: 2, usePct: USE, isWork: true } });
  assert.ok(p.bufferPct <= 1.0 + 1e-9);
});

test('0h window -> amps null and a shortfall', () => {
  const p = nightPlan({ ...base, isWork: true, socPct: 20, usePct: USE, windowHours: 0 });
  assert.equal(p.amps, null);
  assert.equal(p.shortfall, true);
});

test('limit cap: reach above the limit raises raiseLimitTo, target stays at the limit', () => {
  const p = nightPlan({ ...base, isWork: true, socPct: 50, usePct: 50, limitPct: 70, floorPct: 25 });
  assert.equal(p.raiseLimitTo, 80);
  assert.ok(p.targetPct! <= 70 + 1e-9);
});

test('heat cap: only plans without a floor top up to 60%; with the floor the car limit is the stop', () => {
  assert.equal(topUpLimitFor(95), 60);
  assert.equal(topUpLimitFor(85), null);
  assert.equal(topUpLimitFor(null), null);
  const noFloor = nightPlan({ ...base, floorPct: 0, isWork: true, socPct: 55, usePct: USE, topUpLimitPct: 60 });
  assert.ok(Math.abs(noFloor.targetPct! - 60) < 1e-9);
  const offNoFloor = nightPlan({ ...base, floorPct: 0, isWork: false, socPct: 55, usePct: 10, topUpLimitPct: 60 });
  assert.ok(offNoFloor.targetPct! > 60);
  const hot = nightPlan({ ...base, isWork: true, socPct: 20, usePct: USE, topUpLimitPct: 60 });
  const mild = nightPlan({ ...base, isWork: true, socPct: 20, usePct: USE });
  assert.ok(Math.abs(hot.targetPct! - 42.05) < 1e-9);
  assert.equal(hot.amps, mild.amps);
  assert.equal(hot.endPct, mild.endPct);
});

test('nightWindow: conflict flag, fewest hours is the safe reading', () => {
  const w = nightWindow(D, [shift(D, 14, 30, 23, 0, 'a'), shift(D, 6, 30, 16, 0, 'b')]);
  assert.equal(w.conflict, true);
  assert.equal(w.readings.length, 2);
  assert.equal(w.hours, Math.min(...w.readings.map((r) => r.hours)));
  assert.equal(nightWindow(D, [shift(D, 14, 30, 23, 0)]).conflict, false);
  assert.equal(nightWindow(D, []).hours, 8);
});

test('planTonight: conflict picks the reading that needs the most amps', () => {
  const shifts = [shift(D, 14, 30, 23, 0, 'a'), shift(D, 6, 30, 16, 0, 'b')];
  const r = planTonight({
    day: D, shifts, workDays: new Set([D, D + 1]), usePctWork: USE, usePctOff: 10, socPct: 20, limitPct: 70,
    margin: 1.1, floorPct: 25, kwhPerPct: 1.44, minAmps: 6, maxAmps: 48,
  });
  assert.equal(r.conflict, true);
  assert.equal(r.readings.length, 2);
  assert.equal(r.plan.amps, Math.max(...r.readings.map((x) => x.amps ?? 0)));
});

test('sinceHistoryStart: rows before the cutoff are the old Rivian', () => {
  const rows = [{ startedAt: '2026-05-05T12:00:00Z' }, { startedAt: '2026-05-07T12:00:00Z' }];
  assert.equal(sinceHistoryStart(rows, '2026-05-06').length, 1);
  assert.equal(sinceHistoryStart(rows, null).length, 2);
  assert.equal(sinceHistoryStart(rows, 'garbled').length, 2);
  assert.equal(historyStartMs('2026-05-06'), new Date(2026, 4, 6).getTime());
});
