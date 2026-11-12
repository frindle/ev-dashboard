// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/planSlots.test.ts
// Write slots, late-start replan, alerts, ignored shifts, plan builder. All pure; nothing
// here touches the car, Influx, Pushover or the calendar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAmps, lateStartStep, writeSlot } from './rivianSchedule.ts';
import { planAlerts, pruneSent, type AlertCtx } from './planAlerts.ts';
import { applyIgnored, validChoice } from './shiftChoices.ts';
import { buildRivianPlan, forecastHighFor, socForPlan } from './rivianPlan.ts';
import { dayTimeMs, localDayNumber, type Shift } from './chargePlan.ts';

const at = (s: string) => Date.parse(s);
const ALL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const sch = (over: Record<string, unknown> = {}): any => ({ weekDays: ALL, startTime: 0, duration: 480, location: { latitude: 1, longitude: 2 }, amperage: 12, enabled: true, ...over });

test('writeSlot: forecast 08:15-22:45, update 23:00-23:59, once per day', () => {
  const d = (t: string) => at(`2026-11-12T${t}-08:00`);
  const today = localDayNumber(d('12:00:00'));
  assert.equal(writeSlot(d('08:14:00'), {}), null);
  assert.equal(writeSlot(d('08:15:00'), {}), 'forecast');
  assert.equal(writeSlot(d('22:44:00'), {}), 'forecast');
  assert.equal(writeSlot(d('22:45:00'), {}), null);
  assert.equal(writeSlot(d('22:59:00'), {}), null);
  assert.equal(writeSlot(d('23:00:00'), {}), 'update');
  assert.equal(writeSlot(d('23:59:00'), {}), null);
  assert.equal(writeSlot(d('10:00:00'), { forecast: today }), null);
  assert.equal(writeSlot(d('23:15:00'), { forecast: today }), 'update');
  assert.equal(writeSlot(d('23:15:00'), { update: today }), null);
  assert.equal(writeSlot(d('03:00:00'), {}), null);
});

test('decideAmps: the daily plan waits for a slot; an override writes anyway; inside the window only raises', () => {
  const noon = at('2026-11-12T12:00:00-08:00');
  const night = at('2026-11-13T02:00:00-08:00');
  assert.equal(decideAmps({ nowMs: noon, current: sch(), dailyAmps: 20, overrideAmps: null, slot: null }).amps, null);
  assert.equal(decideAmps({ nowMs: noon, current: sch(), dailyAmps: 20, overrideAmps: null, slot: 'forecast' }).amps, 20);
  assert.equal(decideAmps({ nowMs: noon, current: sch(), dailyAmps: 6, overrideAmps: 30, slot: null }).amps, 30);
  assert.equal(decideAmps({ nowMs: night, current: sch(), dailyAmps: 6, overrideAmps: null, slot: null, replanAmps: 24 }).amps, 24);
  assert.equal(decideAmps({ nowMs: night, current: sch(), dailyAmps: 6, overrideAmps: null, slot: null, replanAmps: 8 }).amps, null);
  assert.equal(decideAmps({ nowMs: night, current: sch(), dailyAmps: 6, overrideAmps: null, slot: null, fixRaiseAmps: 16 }).amps, 16);
});

test('lateStartStep: replans once for the hours left; pushes at start + 30', () => {
  const start = at('2026-11-13T00:50:00-08:00');
  const end = at('2026-11-13T08:00:00-08:00');
  const p = { windowStartMs: start, windowEndMs: end, kwhPerPct: 1.44, minAmps: 6, maxAmps: 48, targetPct: 42, socPct: 20, replanned: false };
  const early = lateStartStep({ ...p, nowMs: start + 10 * 60_000, charging: false, lateSeen: false });
  assert.deepEqual(early, { lateSeen: false, replanAmps: null, notChargingPush: false });
  const late = lateStartStep({ ...p, nowMs: start + 20 * 60_000, charging: false, lateSeen: false });
  assert.equal(late.lateSeen, true);
  assert.equal(late.notChargingPush, false);
  const push = lateStartStep({ ...p, nowMs: start + 35 * 60_000, charging: false, lateSeen: true });
  assert.equal(push.notChargingPush, true);
  const go = lateStartStep({ ...p, nowMs: at('2026-11-13T02:00:00-08:00'), charging: true, lateSeen: true });
  // 22% x 1.44 = 31.7 kWh over 6h -> 22A
  assert.equal(go.replanAmps, 22);
  assert.equal(lateStartStep({ ...p, nowMs: at('2026-11-13T02:00:00-08:00'), charging: true, lateSeen: true, replanned: true }).replanAmps, null);
  assert.equal(lateStartStep({ ...p, nowMs: at('2026-11-13T02:00:00-08:00'), charging: true, lateSeen: false }).replanAmps, null);
});

const ctx = (over: Partial<AlertCtx> = {}): AlertCtx => ({
  nowMs: at('2026-11-12T12:00:00-08:00'), today: localDayNumber(at('2026-11-12T12:00:00-08:00')),
  done: {}, sent: new Set(), conflictDay: null, conflictWasOpenDay: null, shortfall: false, atHome: null, plugged: null,
  lastShiftEndMs: null, isOffDay: false, needsCharge: false, limitPct: null, notChargingPush: false, serveDay: 0,
  dashboardUrl: 'https://ev.example.invalid/', ...over,
});
const keys = (c: AlertCtx) => planAlerts(c).map((a) => a.key.split(':')[0]);
const today = localDayNumber(at('2026-11-12T12:00:00-08:00'));

test('alerts: missed slots, sent once', () => {
  assert.deepEqual(keys(ctx({ nowMs: at('2026-11-12T10:15:00-08:00') })), ['forecast-missed']);
  assert.deepEqual(keys(ctx({ nowMs: at('2026-11-12T10:14:00-08:00') })), []);
  assert.deepEqual(keys(ctx({ nowMs: at('2026-11-12T10:15:00-08:00'), done: { forecast: today } })), []);
  assert.ok(keys(ctx({ nowMs: at('2026-11-12T23:45:00-08:00'), done: { forecast: today } })).includes('update-missed'));
  assert.deepEqual(keys(ctx({ nowMs: at('2026-11-12T10:15:00-08:00'), sent: new Set([`forecast-missed:${today}`]) })), []);
});

test('alerts: conflict with a link, 23:00 reminder, fixed', () => {
  const day = today + 1;
  const a = planAlerts(ctx({ conflictDay: day, done: { forecast: today, update: today } }));
  assert.equal(a.length, 1);
  assert.equal(a[0].link?.url, `https://ev.example.invalid/shifts?day=${day}`);
  const night = keys(ctx({ conflictDay: day, nowMs: at('2026-11-12T23:05:00-08:00'), done: { forecast: today, update: today } }));
  assert.ok(night.includes('conflict-2300'));
  const morning = keys(ctx({ conflictDay: day, nowMs: at('2026-11-12T08:20:00-08:00'), done: { forecast: today, update: today } }));
  assert.ok(morning.includes('conflict-0815'));
  assert.deepEqual(keys(ctx({ conflictWasOpenDay: day, done: { forecast: today, update: today } })), ['conflict-fixed']);
});

test('alerts: unplugged after shift, day off 20:00, shortfall, not charging, limit left high', () => {
  const done = { forecast: today, update: today };
  const end = at('2026-11-12T17:00:00-08:00');
  assert.ok(keys(ctx({ done, atHome: true, plugged: false, lastShiftEndMs: end, nowMs: end + 31 * 60_000 })).includes('unplugged-after-shift'));
  assert.ok(!keys(ctx({ done, atHome: true, plugged: false, lastShiftEndMs: end, nowMs: end + 10 * 60_000 })).includes('unplugged-after-shift'));
  assert.ok(keys(ctx({ done, isOffDay: true, atHome: true, plugged: false, needsCharge: true, nowMs: at('2026-11-12T20:00:00-08:00') })).includes('unplugged-day-off'));
  assert.ok(!keys(ctx({ done, isOffDay: true, atHome: true, plugged: true, needsCharge: true, nowMs: at('2026-11-12T20:00:00-08:00') })).includes('unplugged-day-off'));
  assert.ok(keys(ctx({ done, shortfall: true, nowMs: at('2026-11-12T08:15:00-08:00') })).includes('shortfall'));
  assert.ok(keys(ctx({ done, notChargingPush: true })).includes('not-charging'));
  assert.ok(keys(ctx({ done, limitPct: 80, nowMs: at('2026-11-12T08:15:00-08:00') })).includes('limit-high'));
  assert.ok(!keys(ctx({ done, limitPct: 70, nowMs: at('2026-11-12T08:15:00-08:00') })).includes('limit-high'));
});

test('pruneSent drops old keys', () => {
  const now = Date.now();
  assert.deepEqual(Object.keys(pruneSent({ a: now, b: now - 5 * 86_400_000 }, now)), ['a']);
});

test('ignored shifts: dropped by uid, a day with every shift ignored is no longer a work day', () => {
  const d = localDayNumber(at('2026-11-13T12:00:00-08:00'));
  const s = (day: number, uid: string): Shift => ({ day, startMs: dayTimeMs(day, 14), endMs: dayTimeMs(day, 23), uid });
  const shifts = [s(d, 'a'), s(d, 'b'), s(d + 1, 'c')];
  const r = applyIgnored(shifts, new Set([d, d + 1]), new Set(['a']));
  assert.equal(r.shifts.length, 2);
  assert.ok(r.workDays!.has(d));
  const r2 = applyIgnored(shifts, new Set([d, d + 1]), new Set(['c']));
  assert.ok(!r2.workDays!.has(d + 1));
  assert.equal(applyIgnored(shifts, null, new Set(['a'])).workDays, null);
  assert.deepEqual(validChoice({ uid: 'x', action: 'ignore' }), { uid: 'x' });
  assert.equal(validChoice({ uid: 'x', action: 'delete' }), null);
  assert.equal(validChoice({ action: 'ignore' }), null);
});

test('socForPlan: forecast takes the day off, update reads plugged SoC, unplugged takes half a day', () => {
  assert.equal(socForPlan(at('2026-11-12T08:15:00-08:00'), 80, true, 15, 1.1), 80 - 16.5);
  assert.equal(socForPlan(at('2026-11-12T23:00:00-08:00'), 40, true, 15, 1.1), 40);
  assert.equal(socForPlan(at('2026-11-12T23:00:00-08:00'), 60, false, 15, 1.1), 60 - 8.25);
  assert.equal(socForPlan(at('2026-11-13T02:00:00-08:00'), 40, true, 15, 1.1), 40);
  assert.equal(socForPlan(at('2026-11-12T23:00:00-08:00'), null, true, 15, 1.1), null);
});

test('buildRivianPlan: no history -> null; with history, tomorrow work day plans in %', () => {
  const now = at('2026-11-12T23:00:00-08:00');
  const tomorrow = localDayNumber(now) + 1;
  const est = { ewmaKwh: 22, plannedKwh: 22, rates: { workKwh: 22.3, offKwh: 14 }, nextDayWork: true } as any;
  const common = {
    nowMs: now, shifts: [], workDays: new Set([tomorrow]), state: { chargePercent: 50, chargeLimit: 70, isPluggedIn: true },
    kwhPerPct: 1.44, floorPct: 25, margin: 1.1, forecastHighF: null, minAmps: 6, maxAmps: 48,
  };
  assert.equal(buildRivianPlan({ ...common, est: null }), null);
  const b = buildRivianPlan({ ...common, est })!;
  assert.equal(b.serveDay, tomorrow);
  assert.equal(b.result.isWork, true);
  assert.equal(b.socUsed, 50);
  assert.equal(b.result.plan.amps, 14);
  const hot = buildRivianPlan({ ...common, est, state: { chargePercent: 50, chargeLimit: 70, isPluggedIn: true }, forecastHighF: 95 })!;
  assert.ok(hot.result.plan.targetPct! <= 60 + 1e-9);
});

test('forecastHighFor: highest reading on the local day', () => {
  const d = localDayNumber(at('2026-11-13T12:00:00-08:00'));
  const list = [
    { dt: at('2026-11-13T09:00:00-08:00') / 1000, main: { temp_max: 70 } },
    { dt: at('2026-11-13T15:00:00-08:00') / 1000, main: { temp_max: 91 } },
    { dt: at('2026-11-14T15:00:00-08:00') / 1000, main: { temp_max: 99 } },
  ];
  assert.equal(forecastHighFor(list, d), 91);
  assert.equal(forecastHighFor([], d), null);
});
