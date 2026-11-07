// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/rivianSchedule.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAmps, inEvWindow, managedIndex, scheduleWithAmps } from './rivianSchedule.ts';

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

test('scheduleWithAmps: forces 00:00-08:00 + amps on the managed one, keeps the rest; null when unchanged', () => {
  const other = sch({ enabled: false, weekDays: ['Monday'], startTime: 60 });
  const out = scheduleWithAmps([other, sch({ startTime: 23 * 60, amperage: 10 })], 16)!;
  assert.deepEqual(out, [other, sch({ amperage: 16 })]);
  assert.equal(scheduleWithAmps([sch({ amperage: 16 })], 16), null);
  assert.equal(scheduleWithAmps([], 16), null);
  assert.deepEqual(scheduleWithAmps([sch({ enabled: false })], 12), [sch()]);
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
  assert.deepEqual(decideAmps({ nowMs: day, current: sch(), dailyAmps: 14, overrideAmps: null }), { amps: 14, reason: 'daily plan' });
  assert.deepEqual(decideAmps({ nowMs: day, current: sch(), dailyAmps: 14, overrideAmps: 32 }), { amps: 32, reason: 'override' });
  assert.deepEqual(decideAmps({ nowMs: day, current: sch(), dailyAmps: 12, overrideAmps: null }).amps, null);
  assert.equal(decideAmps({ nowMs: day, current: sch({ startTime: 1380 }), dailyAmps: 12, overrideAmps: null }).amps, 12);
  assert.equal(decideAmps({ nowMs: day, current: null, dailyAmps: 12, overrideAmps: null }).amps, null);
  assert.equal(decideAmps({ nowMs: day, current: sch(), dailyAmps: null, overrideAmps: null }).amps, null);
  // In the window: daily plan frozen, override may raise but never lower
  assert.equal(decideAmps({ nowMs: night, current: sch(), dailyAmps: 6, overrideAmps: null }).amps, null);
  assert.deepEqual(decideAmps({ nowMs: night, current: sch(), dailyAmps: 6, overrideAmps: 20 }), { amps: 20, reason: 'override, raised mid-window' });
  assert.equal(decideAmps({ nowMs: night, current: sch(), dailyAmps: 6, overrideAmps: 8 }).amps, null);
  assert.equal(decideAmps({ nowMs: night, current: sch({ startTime: 1380 }), dailyAmps: 6, overrideAmps: 20 }).amps, null);
});
