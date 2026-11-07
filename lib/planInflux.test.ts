// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/planInflux.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShiftDayRecorder, localMidnightMs, planLine, recordPlan, shiftDayLines, SHIFT_DAYS_AHEAD, SHIFT_DAYS_BACK } from './planInflux.ts';

const day = (iso: string) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86_400_000);
const ENV = { INFLUX_URL: 'http://influx.invalid:8086/', INFLUX_TOKEN: 'tok', INFLUX_ORG: 'home', INFLUX_BUCKET: 'metrics' };

function fakeFetch(ok = true) {
  const bodies: string[] = [];
  const impl = async (_url: string, init: { body: string }) => { bodies.push(init.body); return { ok, status: ok ? 204 : 500, text: async () => 'nope' }; };
  return { bodies, impl: impl as never };
}

test('localMidnightMs: local midnight, also on DST days', () => {
  assert.equal(process.env.TZ, 'America/Los_Angeles');
  assert.equal(localMidnightMs(day('2026-11-10')), Date.parse('2026-11-10T00:00:00-08:00'));
  assert.equal(localMidnightMs(day('2026-11-01')), Date.parse('2026-11-01T00:00:00-07:00'));
  assert.equal(localMidnightMs(day('2026-03-08')), Date.parse('2026-03-08T00:00:00-08:00'));
});

test('shiftDayLines: a 0/1 point for every day between the first and last shift, clipped', () => {
  const today = day('2026-11-07');
  const lines = shiftDayLines(new Set([day('2026-11-02'), day('2026-11-04')]), today);
  assert.deepEqual(lines, [
    `ev_shift_day work=1 ${localMidnightMs(day('2026-11-02'))}`,
    `ev_shift_day work=0 ${localMidnightMs(day('2026-11-03'))}`,
    `ev_shift_day work=1 ${localMidnightMs(day('2026-11-04'))}`,
  ]);
  assert.equal(shiftDayLines(new Set([today - 1000, today + 1000]), today).length, SHIFT_DAYS_BACK + SHIFT_DAYS_AHEAD + 1);
  assert.deepEqual(shiftDayLines(new Set(), today), []);
});

test('planLine: floats and 0/1, unknowns left out', () => {
  assert.equal(planLine('rivian', { planned_kwh: 20.61234, next_day_work: true, gap_kwh: null, floor_kwh: undefined, wrote_amps: NaN, car_amps: 14 }, 5),
    'ev_charge_plan,vehicle=rivian planned_kwh=20.612,next_day_work=1,car_amps=14 5');
  assert.equal(planLine('rivian', { gap_kwh: null }, 5), null);
});

test('recorders: write once per calendar refresh, retry after a failure, never throw', async () => {
  const rec = createShiftDayRecorder();
  const days = new Set([day('2026-11-02'), day('2026-11-03')]);
  const bad = fakeFetch(false);
  const orig = console.error;
  console.error = () => {};
  try {
    assert.equal(await rec(days, day('2026-11-07'), ENV, bad.impl), 0);
    const good = fakeFetch();
    assert.equal(await rec(days, day('2026-11-07'), ENV, good.impl), 2);
    assert.equal(await rec(days, day('2026-11-07'), ENV, good.impl), 0);            // same Set: already written
    assert.equal(await rec(new Set(days), day('2026-11-07'), ENV, good.impl), 2);   // refreshed
    assert.equal(await rec(null, day('2026-11-07'), ENV, good.impl), 0);
    assert.equal(await rec(new Set(days), day('2026-11-07'), {}, good.impl), 0);   // Influx not configured
    assert.equal(good.bodies.length, 2);
    assert.equal(await recordPlan('rivian', { planned_kwh: 20 }, 5, ENV, bad.impl), false);
    const p = fakeFetch();
    assert.equal(await recordPlan('rivian', { planned_kwh: 20 }, 5, ENV, p.impl), true);
    assert.deepEqual(p.bodies, ['ev_charge_plan,vehicle=rivian planned_kwh=20 5']);
  } finally {
    console.error = orig;
  }
});
