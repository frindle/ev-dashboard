// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/planSlots.test.ts
// Write slots, late-start replan, alerts, ignored shifts, plan builder. All pure; nothing
// here touches the car, Influx, Pushover or the calendar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAmps, lateStartStep, writeSlot } from './rivianSchedule.ts';
import { arrivalPlugAlert, planAlerts, plugDecision, pruneSent, type AlertCtx, type ArrivalCtx } from './planAlerts.ts';
import { applyIgnored, validChoice } from './shiftChoices.ts';
import { buildRivianPlan, driveTimeTemps, forecastHighFor, forecastTempsFrom, socForPlan } from './rivianPlan.ts';
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
  lastShiftEndMs: null, isOffDay: false, needsCharge: false, plugNeeded: null, limitPct: null, notChargingPush: false, serveDay: 0,
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
  assert.ok(keys(ctx({ done, notChargingPush: true, plugged: true, needsCharge: true })).includes('not-charging'));
  assert.ok(!keys(ctx({ done, notChargingPush: true, plugged: true, needsCharge: false })).includes('not-charging'));
  assert.ok(!keys(ctx({ done, notChargingPush: true, plugged: false, needsCharge: true })).includes('not-charging'));
  assert.ok(!keys(ctx({ done, notChargingPush: true, plugged: null, needsCharge: true })).includes('not-charging'));
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
    nowMs: now, shifts: [], workDays: new Set([tomorrow]), state: { chargePercent: 30, chargeLimit: 70, isPluggedIn: true },
    kwhPerPct: 1.44, floorPct: 25, margin: 1.1, forecastHighF: null, minAmps: 6, maxAmps: 48,
  };
  assert.equal(buildRivianPlan({ ...common, est: null }), null);
  const b = buildRivianPlan({ ...common, est })!;
  assert.equal(b.serveDay, tomorrow);
  assert.equal(b.result.isWork, true);
  assert.equal(b.socUsed, 30);
  assert.equal(b.result.plan.amps, 10);
  const hot = buildRivianPlan({ ...common, est, forecastHighF: 95 })!;   // a hot day plans the same: the car's limit is the stop
  assert.equal(hot.result.plan.amps, b.result.plan.amps);
});

test('buildRivianPlan: daily-use override plans without history; a null side falls back to history', () => {
  const now = at('2026-11-12T23:00:00-08:00');
  const tomorrow = localDayNumber(now) + 1;
  const est = { ewmaKwh: 22, plannedKwh: 22, rates: { workKwh: 22.3, offKwh: 14 }, nextDayWork: true } as any;
  const common = {
    nowMs: now, shifts: [], workDays: new Set([tomorrow]), state: { chargePercent: 50, chargeLimit: 70, isPluggedIn: true },
    kwhPerPct: 1.44, floorPct: 25, margin: 1.1, forecastHighF: null, minAmps: 6, maxAmps: 48,
  };
  const o = buildRivianPlan({ ...common, est: null, useOverride: { work: 20, off: 8 } })!;
  assert.equal(o.usePctWork, 20);
  assert.equal(o.usePctOff, 8);
  assert.deepEqual(o.needSource, { work: 'daily-use', off: 'daily-use' });
  assert.equal(buildRivianPlan({ ...common, est: null, useOverride: { work: 20, off: null } }), null);
  const mixed = buildRivianPlan({ ...common, est, useOverride: { work: null, off: 8 } })!;
  assert.deepEqual(mixed.needSource, { work: 'charge-history', off: 'daily-use' });
  assert.ok(Math.abs(mixed.usePctWork - 22.3 / 1.44) < 1e-9);
  const hist = buildRivianPlan({ ...common, est, useOverride: null })!;
  assert.deepEqual(hist.needSource, { work: 'charge-history', off: 'charge-history' });
});

test('driveTimeTemps: nearest forecast to leaving (start - 1h) and coming home, within 3h, that day only', () => {
  const d = localDayNumber(at('2026-11-13T12:00:00-08:00'));
  const shifts: Shift[] = [
    { day: d, startMs: at('2026-11-13T11:00:00-08:00'), endMs: at('2026-11-13T19:30:00-08:00') },
    { day: d + 1, startMs: at('2026-11-14T11:00:00-08:00'), endMs: at('2026-11-14T19:30:00-08:00') },
  ];
  const temps = forecastTempsFrom([
    { dt: at('2026-11-13T09:00:00-08:00') / 1000, main: { temp: 41 } },
    { dt: at('2026-11-13T12:00:00-08:00') / 1000, main: { temp: 55 } },
    { dt: at('2026-11-13T18:00:00-08:00') / 1000, main: { temp: 48 } },
    { dt: at('2026-11-14T03:00:00-08:00') / 1000, main: {} },
  ]);
  assert.equal(temps.length, 3);
  assert.deepEqual(driveTimeTemps(temps, shifts, d), [41, 48]);     // leave 10:00 -> 09:00 (1h, vs 12:00 at 2h); home 19:30 -> 18:00
  assert.deepEqual(driveTimeTemps(temps, shifts, d + 1), []);       // nothing within 3h of the 14th's times
  assert.deepEqual(driveTimeTemps(temps, [], d), []);
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

test('plugDecision: real SoC against tomorrow (floor + use x margin + buffer); a target ahead counts', () => {
  // tomorrow reach 25 + 20 x 1.1 = 47
  assert.deepEqual(plugDecision({ socPct: 40, reachPct: 47, bufferPct: 0, override: null }), { needed: true, requiredPct: 47, reason: 'tomorrow' });
  assert.equal(plugDecision({ socPct: 52, reachPct: 47, bufferPct: 0, override: null }).needed, false);
  // a short next night adds its buffer
  assert.equal(plugDecision({ socPct: 50, reachPct: 47, bufferPct: 6, override: null }).needed, true);
  assert.equal(plugDecision({ socPct: 52, reachPct: 47, bufferPct: 0, override: { targetPct: 65, byMs: 0 } }).reason, 'override');
  assert.equal(plugDecision({ socPct: null, reachPct: 47, bufferPct: 0, override: null }).needed, null);
  assert.equal(plugDecision({ socPct: 50, reachPct: null, bufferPct: 0, override: null }).needed, null);
});

test('arrivalPlugAlert: once after a shift, plug in or not; not on an arrival outside the shift window', () => {
  const end = at('2026-11-12T17:00:00-08:00');
  const base: ArrivalCtx = {
    nowMs: end + 25 * 60_000, today, sent: new Set(), shiftEndsMs: [end], socPct: 40,
    decision: plugDecision({ socPct: 40, reachPct: 47, bufferPct: 0, override: null }), override: null, amps: 8, raiseLimitTo: null,
  };
  const a = arrivalPlugAlert(base)!;
  assert.equal(a.title, 'Plug in the Rivian');
  assert.match(a.message, /At 40%\. Tomorrow needs 47%/);
  assert.match(a.message, /8A from midnight/);
  const no = arrivalPlugAlert({ ...base, socPct: 55, decision: plugDecision({ socPct: 55, reachPct: 47, bufferPct: 0, override: null }) })!;
  assert.equal(no.title, 'No need to plug in');
  assert.match(no.message, /At 55%, and tomorrow needs 47%/);
  // errands after work still count; the next morning does not
  assert.ok(arrivalPlugAlert({ ...base, nowMs: end + 7 * 3_600_000 }));
  assert.equal(arrivalPlugAlert({ ...base, nowMs: end + 9 * 3_600_000 }), null);
  assert.equal(arrivalPlugAlert({ ...base, shiftEndsMs: [] }), null);
  // once a day
  assert.equal(arrivalPlugAlert({ ...base, sent: new Set([a.key]) }), null);
  // unknown SoC: plug in to be safe
  assert.equal(arrivalPlugAlert({ ...base, socPct: null, decision: plugDecision({ socPct: null, reachPct: 47, bufferPct: 0, override: null }) })!.title, 'Plug in the Rivian');
});

test('unplugged-after-shift reminder only when the car needs the charge', () => {
  const done = { forecast: today, update: today };
  const end = at('2026-11-12T17:00:00-08:00');
  const c = { done, atHome: true, plugged: false, lastShiftEndMs: end, nowMs: end + 31 * 60_000 };
  assert.ok(keys(ctx({ ...c, plugNeeded: true })).includes('unplugged-after-shift'));
  assert.ok(!keys(ctx({ ...c, plugNeeded: false })).includes('unplugged-after-shift'));
});

test('buildRivianPlan: a typed need only raises the day (max with the model), tonight and the next day\'s buffer', () => {
  const now = at('2026-11-12T23:00:00-08:00');
  const tomorrow = localDayNumber(now) + 1;
  const common = {
    nowMs: now, est: null, shifts: [], workDays: new Set([tomorrow]), state: { chargePercent: 30, chargeLimit: 70, isPluggedIn: true },
    kwhPerPct: 1.44, floorPct: 25, margin: 1.1, forecastHighF: null, minAmps: 6, maxAmps: 48, useOverride: { work: 20, off: 8 },
  };
  const plain = buildRivianPlan(common)!;
  const below = buildRivianPlan({ ...common, typedUse: { [tomorrow]: 10 } })!;   // under the 20% model: ignored
  assert.equal(below.result.plan.totalPct, plain.result.plan.totalPct);
  assert.equal(below.result.plan.amps, plain.result.plan.amps);
  const above = buildRivianPlan({ ...common, typedUse: { [tomorrow]: 30 } })!;    // total driving 30%, not 20% + 30%
  assert.ok(Math.abs(above.result.plan.reachPct! - (25 + 30 * 1.1)) < 1e-9);
  assert.ok(above.result.plan.totalPct > plain.result.plan.totalPct);
  // the day after: its typed use raises the short-night buffer base, a lower one changes nothing
  const next = buildRivianPlan({ ...common, typedUse: { [tomorrow + 1]: 5 } })!;
  assert.equal(next.result.plan.totalPct, plain.result.plan.totalPct);
});
