// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/rivianSchedule.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAmps, inEvWindow, inWindowShape, listInShape, managedIndex, noNeedFits, scheduleWithAmps, shapeOf } from './rivianSchedule.ts';

const LOC = { latitude: 1, longitude: 2 };
const ALL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const sch = (over: Record<string, unknown> = {}): any => ({ weekDays: ALL, startTime: 0, duration: 480, location: LOC, amperage: 12, enabled: true, ...over });
const at = (s: string) => Date.parse(s);

test('managedIndex: enabled first, then most weekdays', () => {
  assert.equal(managedIndex([]), -1);
  assert.equal(managedIndex([sch({ enabled: false }), sch({ weekDays: ['Monday'] })]), 1);
  assert.equal(managedIndex([sch({ weekDays: ['Monday'] }), sch()]), 1);
  assert.equal(managedIndex([sch({ enabled: false }), sch({ enabled: false, weekDays: ['Monday'] })]), 0);
});

test('scheduleWithAmps: one all-days 00:00-08:00 entry at amps; null when the car already runs it', () => {
  const other = sch({ enabled: false, weekDays: ['Monday'], startTime: 60 });
  const out = scheduleWithAmps([other, sch({ startTime: 23 * 60, amperage: 10 })], 16)!;
  assert.deepEqual(out, [sch({ amperage: 16 })]);
  assert.equal(scheduleWithAmps([sch({ amperage: 16 })], 16), null);
  assert.equal(scheduleWithAmps([other, sch({ amperage: 16 })], 16), null); // disabled leftovers are fine
  assert.equal(scheduleWithAmps([], 16), null);
  assert.deepEqual(scheduleWithAmps([sch({ enabled: false })], 12), [sch()]);
});

test("scheduleWithAmps: the app's every-day + weekday + weekend trio becomes one entry (Rivian rejects overlapping weekDays)", () => {
  const WD = ALL.slice(0, 5), WE = ALL.slice(5);
  const car = [
    sch({ amperage: 48, enabled: false }),
    sch({ weekDays: WD, startTime: 1, duration: 479 }),
    sch({ weekDays: WE, startTime: 1, duration: 479 }),
  ];
  assert.equal(listInShape(car), false);
  const out = scheduleWithAmps(car, 8)!;
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], sch({ amperage: 8 }));
  // A weekday-only schedule at the right window is not enough: the weekend is uncontrolled.
  assert.equal(listInShape([sch({ weekDays: WD })]), false);
  // Another enabled schedule alongside keeps the list out of shape.
  assert.equal(listInShape([sch(), sch({ weekDays: WE, startTime: 600, duration: 60 })]), false);
  assert.equal(listInShape([sch()]), true);
});

test('decideAmps: an out-of-shape list is rewritten in the slot even at the same amps', () => {
  const noon = at('2026-11-13T12:00:00-08:00');
  const d = decideAmps({ nowMs: noon, current: sch({ amperage: 12 }), dailyAmps: 12, overrideAmps: null, slot: 'forecast', inShape: false });
  assert.equal(d.amps, 12);
  assert.equal(decideAmps({ nowMs: noon, current: sch({ amperage: 12 }), dailyAmps: 12, overrideAmps: null, slot: 'forecast', inShape: true }).amps, null);
});

test('inEvWindow: midnight to 08:00 local', () => {
  assert.equal(process.env.TZ, 'America/Los_Angeles');
  assert.equal(inEvWindow(at('2026-11-09T00:00:00-08:00')), true);
  assert.equal(inEvWindow(at('2026-11-09T07:59:00-08:00')), true);
  assert.equal(inEvWindow(at('2026-11-09T08:00:00-08:00')), false);
  assert.equal(inEvWindow(at('2026-11-09T23:59:00-08:00')), false);
});

test('decideAmps: outside the window syncs to max(daily, override); inside only an override raises', () => {
  const day = at('2026-11-09T21:00:00-08:00');
  const night = at('2026-11-10T02:00:00-08:00');
  assert.deepEqual(decideAmps({ slot: 'update', nowMs: day, current: sch(), dailyAmps: 14, overrideAmps: null }), { amps: 14, reason: 'update slot, daily plan' });
  assert.deepEqual(decideAmps({ slot: 'update', nowMs: day, current: sch(), dailyAmps: 14, overrideAmps: 32 }), { amps: 32, reason: 'update slot, override' });
  assert.deepEqual(decideAmps({ slot: 'update', nowMs: day, current: sch(), dailyAmps: 12, overrideAmps: null }).amps, null);
  assert.equal(decideAmps({ slot: 'update', nowMs: day, current: sch({ startTime: 1380 }), dailyAmps: 12, overrideAmps: null }).amps, 12);
  assert.equal(decideAmps({ slot: 'update', nowMs: day, current: null, dailyAmps: 12, overrideAmps: null }).amps, null);
  assert.equal(decideAmps({ slot: 'update', nowMs: day, current: sch(), dailyAmps: null, overrideAmps: null }).amps, null);
  // In the window: daily plan frozen, override may raise but never lower
  assert.equal(decideAmps({ slot: null, nowMs: night, current: sch(), dailyAmps: 6, overrideAmps: null }).amps, null);
  assert.deepEqual(decideAmps({ slot: null, nowMs: night, current: sch(), dailyAmps: 6, overrideAmps: 20 }), { amps: 20, reason: 'override, raised mid-window' });
  assert.equal(decideAmps({ slot: null, nowMs: night, current: sch(), dailyAmps: 6, overrideAmps: 8 }).amps, null);
  assert.equal(decideAmps({ slot: null, nowMs: night, current: sch({ startTime: 1380 }), dailyAmps: 6, overrideAmps: 20 }).amps, null);
});

const hold = (over: Record<string, unknown> = {}) => sch({ duration: 1, amperage: 8, ...over });

test('shapes: charge (0/480) and hold (0/1) are both the managed schedule; other durations are not', () => {
  assert.equal(shapeOf(sch()), 'charge');
  assert.equal(shapeOf(hold()), 'hold');
  assert.equal(shapeOf(sch({ duration: 60 })), null);
  assert.equal(shapeOf(hold({ enabled: false })), null);
  assert.equal(inWindowShape(hold()), true);
  assert.equal(listInShape([hold()]), true);
  assert.equal(listInShape([hold(), sch({ weekDays: ['Monday'], startTime: 600, duration: 60 })]), false);
  assert.equal(managedIndex([sch({ duration: 60 }), hold()]), 1);
  assert.equal(managedIndex([hold({ enabled: false }), hold()]), 1);
});

test('scheduleWithAmps: hold writes the one-minute entry; hold and charge are not the same', () => {
  const h = scheduleWithAmps([sch({ amperage: 12 })], 8, true)!;
  assert.equal(h.length, 1);
  assert.deepEqual([h[0].startTime, h[0].duration, h[0].amperage, h[0].enabled, h[0].weekDays.length], [0, 1, 8, true, 7]);
  assert.equal(scheduleWithAmps([hold()], 8, true), null);
  assert.equal(scheduleWithAmps([hold()], 8)![0].duration, 480);
  assert.equal(scheduleWithAmps([sch({ amperage: 8 })], 8, true)![0].duration, 1);
});

test('noNeedFits: 8A (1.92 kW) must fit the p30 room; unknown room does not fit', () => {
  assert.equal(noNeedFits([], 8), false);
  assert.equal(noNeedFits([0, 1.9, 5, 6, 7], 8), false);
  assert.equal(noNeedFits([0, 1.92, 5, 6, 7], 8), true);
  assert.equal(noNeedFits([9, 1.0, 9, 9, 9], 8), false);   // the p30 entry, not p10
});

test('decideAmps: no-need night in a write slot holds or charges 8A by room, once', () => {
  const day = at('2026-11-09T23:00:00-08:00');
  const base = { slot: 'update' as const, nowMs: day, dailyAmps: null, overrideAmps: null };
  assert.deepEqual(decideAmps({ ...base, current: sch({ amperage: 20 }), noNeed: { fits: false, minAmps: 8 } }),
    { amps: 8, hold: true, reason: 'update slot, no-need night, hold' });
  assert.equal(decideAmps({ ...base, current: hold(), noNeed: { fits: false, minAmps: 8 } }).amps, null);
  const fits = decideAmps({ ...base, current: hold(), noNeed: { fits: true, minAmps: 8 } });
  assert.equal(fits.amps, 8); assert.equal(fits.hold, undefined);
  assert.equal(decideAmps({ ...base, current: sch({ amperage: 8 }), noNeed: { fits: true, minAmps: 8 } }).amps, null);
  // an override that needs amps beats the hold; without noNeed the plan is as before
  const ov = decideAmps({ ...base, current: hold(), overrideAmps: 24, noNeed: { fits: false, minAmps: 8 } });
  assert.deepEqual([ov.amps, ov.hold], [24, undefined]);
  const plain = decideAmps({ ...base, current: hold(), dailyAmps: 14 });
  assert.deepEqual([plain.amps, plain.hold], [14, undefined]);
});

test('decideAmps: inside the window charge -> hold is never written; hold -> charge only as a raise', () => {
  const night = at('2026-11-10T02:00:00-08:00');
  const base = { slot: 'update' as const, nowMs: night, dailyAmps: null, overrideAmps: null };
  assert.equal(decideAmps({ ...base, current: sch({ amperage: 20 }), noNeed: { fits: false, minAmps: 8 } }).amps, null);
  assert.equal(decideAmps({ ...base, slot: null, current: hold(), dailyAmps: 14 }).amps, null);          // daily plan frozen
  assert.equal(decideAmps({ ...base, slot: null, current: hold(), noNeed: { fits: true, minAmps: 8 } }).amps, null);
  assert.equal(decideAmps({ ...base, slot: null, current: hold(), overrideAmps: 8 }).amps, 8);           // 8A is still a raise from hold
  assert.equal(decideAmps({ ...base, slot: null, current: hold(), replanAmps: 12 }).amps, 12);
  assert.equal(decideAmps({ ...base, slot: null, current: hold(), fixRaiseAmps: 16 }).amps, 16);
  assert.equal(decideAmps({ ...base, slot: null, current: hold(), overrideAmps: 24, replanAmps: 12 }).amps, 24);
  assert.equal(decideAmps({ ...base, slot: null, current: hold(), overrideAmps: 24, inShape: false }).amps, null);
});

test('decideAmps: between slots an override still rewrites a hold', () => {
  const noon = at('2026-11-09T12:00:00-08:00');
  assert.equal(decideAmps({ slot: null, nowMs: noon, current: hold(), dailyAmps: null, overrideAmps: 8 }).amps, 8);
  assert.equal(decideAmps({ slot: null, nowMs: noon, current: hold(), dailyAmps: null, overrideAmps: null }).amps, null);
});

test('decideAmps: a hold is lifted when tonight is needed in the window, or a slot has no plan', () => {
  const night = at('2026-11-10T02:00:00-08:00');
  const base = { slot: null, nowMs: night, dailyAmps: null, overrideAmps: null };
  const lift = decideAmps({ ...base, current: hold(), holdLiftAmps: 12 });
  assert.deepEqual([lift.amps, lift.hold], [12, undefined]);
  assert.equal(decideAmps({ ...base, current: sch({ amperage: 8 }), holdLiftAmps: 12 }).amps, null);   // only from a hold
  const day = at('2026-11-09T23:00:00-08:00');
  const noPlan = decideAmps({ ...base, slot: 'update', nowMs: day, current: hold() });
  assert.deepEqual([noPlan.amps, noPlan.hold], [8, undefined]);
  assert.equal(decideAmps({ ...base, slot: 'update', nowMs: day, current: sch({ amperage: 8 }) }).amps, null);
});
