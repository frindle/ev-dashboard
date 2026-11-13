// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/rivianSchedule.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAmps, inEvWindow, listInShape, managedIndex, scheduleWithAmps } from './rivianSchedule.ts';

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
