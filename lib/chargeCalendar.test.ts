// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/chargeCalendar.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHARGE_CAL_DAYS, projectNights, type CalDayIn, type ProjectInput } from './chargeCalendar.ts';
import { dayTimeMs, type Shift } from './chargePlan.ts';
import { milesForPct, needUsePct, pctForMiles } from './tripPlan.ts';
import { validNeed } from './tripStore.ts';

const D0 = Math.round(Date.parse('2026-11-13T00:00:00Z') / 86_400_000);
const mk = (n: number, over: Partial<CalDayIn> = {}): CalDayIn[] => Array.from({ length: n }, (_, i) => ({
  day: D0 + i, isWork: false, away: false, usePct: 12, useSource: 'day-off average', highF: 60, tripMiles: null, ...over,
}));
const base = (days: CalDayIn[], over: Partial<ProjectInput> = {}): ProjectInput => ({
  days, shifts: [], startSocPct: 60, limitPct: 70, floorPct: 25, margin: 1.1, kwhPerPct: 1.44, minAmps: 8, maxAmps: 48, ...over,
});

test('projection: plugs in only when the morning must be raised; sawtooth carries the SoC', () => {
  const n = projectNights(base(mk(5)));
  assert.equal(n.length, 5);
  assert.equal(n[0].charge, false);                      // 60% already covers 25 + 12 x 1.1
  assert.equal(n[0].morningPct, 60);
  assert.ok(Math.abs(n[0].arrivalPct! - 48) < 1e-9);
  assert.equal(n[1].socIn, n[0].arrivalPct);
  assert.ok(n.some((x) => x.charge));                    // 60 falls, so a charge shows up
  for (const x of n) {
    if (x.charge) { assert.ok(x.amps! >= 8); assert.ok(x.morningPct! <= 70 + 1e-9); assert.ok(x.addedPct > 0); }
    else assert.equal(x.addedPct, 0);
  }
  assert.ok(n.every((x) => x.arrivalPct! >= 25 - 1e-6 || x.shortfall));
});

test('projection: a bigger day raises the next charge; unknown SoC gives no plug-in call', () => {
  const small = projectNights(base(mk(3)));
  const big = projectNights(base(mk(3).map((d, i) => (i === 0 ? { ...d, usePct: 30 } : d))));
  assert.ok(big[1].addedPct >= small[1].addedPct);
  const unknown = projectNights(base(mk(3), { startSocPct: null }));
  assert.ok(unknown.every((x) => x.charge === null && x.morningPct === null));
});

test('projection: early shift shortens the window; away day has no charge window', () => {
  const shifts: Shift[] = [{ day: D0 + 1, startMs: dayTimeMs(D0 + 1, 5, 0), endMs: dayTimeMs(D0 + 1, 13, 0) }];
  const n = projectNights(base(mk(3, { isWork: false }), { shifts, startSocPct: 30 }));
  assert.ok(n[1].windowHours < 8 && n[1].windowHours >= 0);
  const away = projectNights(base(mk(3).map((d, i) => (i === 1 ? { ...d, away: true } : d)), { startSocPct: 30 }));
  assert.equal(away[1].windowHours, 0);
  assert.equal(away[1].charge, false);
});

test('low start plugs in on night 0; the calendar spans 14 days', () => {
  assert.ok(projectNights(base(mk(2), { startSocPct: 30 }))[0].charge);
  assert.equal(CHARGE_CAL_DAYS, 14);
});

test('typed need helpers: pct as typed, miles through the high, 0 rejected', () => {
  assert.equal(needUsePct({ value: 25, unit: 'pct' }, 70), 25);
  assert.equal(needUsePct({ value: 60, unit: 'mi' }, 70), pctForMiles(60, 70));
  assert.equal(milesForPct(pctForMiles(60, 70), 70), 60);
  assert.equal(validNeed({ value: 0, unit: 'mi' }), null);
  assert.deepEqual(validNeed({ value: 12.4, unit: 'mi' }), { value: 12, unit: 'mi' });
});
