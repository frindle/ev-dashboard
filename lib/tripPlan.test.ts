// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/tripPlan.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjustForTrip, awayDays, choiceKey, metersBetween, milesPerPct, planTripDay, type TripDayInput, type TripEvent, manualAdjust, pctForMiles } from './tripPlan.ts';
import type { LatLon } from './ics.ts';

const DAY = Math.round(Date.UTC(2026, 10, 17) / 86_400_000);
const at = (h: number) => new Date(2026, 10, 17, h).getTime();
const HOME: LatLon = { lat: 36, lon: -115 };
const P = (dLat: number, dLon = 0): LatLon => ({ lat: 36 + dLat, lon: -115 + dLon });
const NEAR = P(0.1);            // ~6.9 mi, ~14 min
const A = P(0.5);               // ~34 mi
const B = P(-0.5);
const WORK = P(0, 0.3);         // ~17 mi east
const MIN_PER_MI = 2;           // 30 mph

const route = async (a: LatLon, b: LatLon) => {
  const mi = metersBetween(a, b) / 1609.344;
  return { miles: mi, seconds: mi * MIN_PER_MI * 60 };
};
const ev = (uid: string, sh: number, eh: number, point: LatLon | null, x: Partial<TripEvent> = {}): TripEvent => ({
  uid, startMs: at(sh), endMs: at(eh), allDay: false, multiDay: false, tag: null, point, ...x,
});
const input = (events: TripEvent[], x: Partial<TripDayInput> = {}): TripDayInput => ({
  day: DAY, localMs: at, home: HOME, homeRadiusM: 150, shift: null, work: null, events, choices: {}, toggles: {}, route, ...x,
});
const SHIFT = { startMs: at(9), endMs: at(17) };
const near = (a: number, b: number, tol = 0.6) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test('plan table: mpp by high; lunch 4 mi -> 10%; 140 mi at 80F -> need 56, 81% by departure', () => {
  assert.equal(milesPerPct(80), 2.88);
  assert.equal(milesPerPct(30), 1.95);
  assert.equal(milesPerPct(null), 1.95);
  const lunch = adjustForTrip({ isWork: false, baseNeedPct: 10, miles: 8, extraMiles: 0, highF: 80 });
  assert.equal(Math.round(lunch.tripPct * 1.1), 5);
  assert.equal(lunch.needPct, 10);
  assert.equal(lunch.raise, false);
  const far = adjustForTrip({ isWork: false, baseNeedPct: 10, miles: 140, extraMiles: 0, highF: 80 });
  assert.equal(far.needPct, 56);
  assert.equal(far.targetPct, 81);
  assert.equal(far.raise, true);
});

test('work day: raise only, base + extra', () => {
  const none = adjustForTrip({ isWork: true, baseNeedPct: 20, miles: 40, extraMiles: 0, highF: 80 });
  assert.deepEqual([none.needPct, none.raise, none.targetPct], [20, false, 45]);
  const some = adjustForTrip({ isWork: true, baseNeedPct: 20, miles: 60, extraMiles: 28.8, highF: 80 });
  assert.deepEqual([some.needPct, some.raise], [31, true]);
});

test('no located events -> null; unplaced only flags', async () => {
  assert.equal(await planTripDay(input([])), null);
  const d = await planTripDay(input([ev('u', 12, 13, null)]));
  assert.deepEqual([d!.unplaced, d!.miles, d!.stops.length, d!.departMs], [['u'], 0, 0, null]);
});

test('single far event on a day off: round trip, depart = start - drive - max(15 min, 20%)', async () => {
  const d = (await planTripDay(input([ev('a', 12, 13, A)])))!;
  const oneWay = metersBetween(HOME, A) / 1609.344;
  near(d.miles, oneWay * 2);
  const driveMin = oneWay * MIN_PER_MI;
  near(d.departMs!, at(12) - (driveMin + Math.max(15, driveMin * 0.2)) * 60_000, 60_000);
  assert.equal(d.stops[0].after, 'home');
});

test('near-home events are separate round trips; #straight stops that', async () => {
  const two = [ev('n1', 10, 11, NEAR), ev('n2', 12, 13, NEAR)];
  const d = (await planTripDay(input(two)))!;
  assert.deepEqual(d.stops.map((s) => s.rule), ['near', 'near']);
  near(d.miles, 4 * metersBetween(HOME, NEAR) / 1609.344);
  const s = (await planTripDay(input([ev('n1', 10, 11, NEAR, { tag: 'straight' })])))!;
  assert.notEqual(s.stops[0].rule, 'near');
});

test('event at home is a home stop with no drive', async () => {
  const d = (await planTripDay(input([ev('h', 12, 13, P(0.0002))])))!;
  assert.equal(d.stops[0].kind, 'home');
  assert.equal(d.miles, 0);
});

test('gap rule: big gap goes home first, small gap stays out; tags and toggles override', async () => {
  const legMi = metersBetween(A, B) / 1609.344;
  const out = (e1: number, s2: number, extra: Partial<TripDayInput> = {}, t1: Partial<TripEvent> = {}) =>
    planTripDay(input([ev('a', 8, e1, A, t1), ev('b', s2, s2 + 1, B)], extra));
  const big = (await out(9, 20))!;       // 11 h gap
  assert.deepEqual([big.stops[0].after, big.stops[0].rule], ['home', 'gap']);
  const small = (await out(9, 11))!;     // 2 h gap < back + out + 1h
  assert.deepEqual([small.stops[0].after, small.stops[0].rule], ['straight', 'gap']);
  near(small.miles, 34.4 + legMi + 34.4, 3);
  assert.equal((await out(9, 20, {}, { tag: 'straight' }))!.stops[0].after, 'straight');
  assert.equal((await out(9, 11, {}, { tag: 'home' }))!.stops[0].after, 'home');
  const tog = await out(9, 20, { toggles: { [choiceKey('a', DAY)]: 'straight' } }, { tag: 'home' });
  assert.deepEqual([tog!.stops[0].after, tog!.stops[0].rule], ['straight', 'toggle']);
});

test('work day ordering: home -> before-shift event -> work -> after-shift event -> home', async () => {
  const d = (await planTripDay(input([ev('after', 18, 19, A), ev('before', 7, 8, B)], { shift: SHIFT, work: WORK })))!;
  assert.deepEqual(d.stops.map((s) => s.kind === 'work' ? 'work' : s.uid), ['before', 'work', 'after']);
  assert.ok(d.extraMiles > 0);
  assert.ok(d.departMs! < at(7));
});

test('work day with no extra events: no extra miles; event overlapping shift is a round trip from work and flagged until chosen', async () => {
  const none = (await planTripDay(input([ev('x', 18, 19, WORK)], { shift: SHIFT, work: WORK })))!;
  assert.equal(none.extraMiles < 0.5, true);
  const ov = [ev('o', 12, 13, A)];
  const open = (await planTripDay(input(ov, { shift: SHIFT, work: WORK })))!;
  assert.deepEqual(open.overlaps, ['o']);
  assert.equal(open.stops.find((s) => s.uid === 'o')!.rule, 'overlap');
  assert.ok(open.extraMiles > 30);
  const going = (await planTripDay(input(ov, { shift: SHIFT, work: WORK, choices: { [choiceKey('o', DAY)]: 'going' } })))!;
  assert.deepEqual(going.overlaps, []);
  assert.ok(going.extraMiles > 30);
  const skipped = await planTripDay(input(ov, { shift: SHIFT, work: WORK, choices: { [choiceKey('o', DAY)]: 'skip' } }));
  assert.equal(skipped!.extraMiles < 0.5 && skipped!.overlaps.length === 0, true);
});

test('overlapping events in different places are both counted', async () => {
  const d = (await planTripDay(input([ev('a', 12, 14, A), ev('b', 13, 15, B)])))!;
  assert.equal(d.stops.length, 2);
  assert.ok(d.miles > 2 * 34);
});

test('all-day: destination at 08:00 on a day off, after the shift on a work day', async () => {
  const off = (await planTripDay(input([ev('d', 0, 0, A, { allDay: true })])))!;
  assert.equal(off.stops.length, 1);
  assert.ok(off.departMs! < at(8));
  const wk = (await planTripDay(input([ev('d', 0, 0, A, { allDay: true })], { shift: SHIFT, work: WORK })))!;
  assert.deepEqual(wk.stops.map((s) => s.kind), ['work', 'event']);
});

test('multi-day: outbound leg only, flagged, later days are away', async () => {
  const e = ev('m', 10, 10, A, { multiDay: true, endMs: new Date(2026, 10, 20, 10).getTime() });
  const d = (await planTripDay(input([e])))!;
  assert.equal(d.multiDay, true);
  near(d.miles, metersBetween(HOME, A) / 1609.344);
  const dayOf = (ms: number) => Math.round(Date.UTC(new Date(ms).getFullYear(), new Date(ms).getMonth(), new Date(ms).getDate()) / 86_400_000);
  assert.deepEqual([...awayDays([{ day: DAY, startMs: e.startMs, endMs: e.endMs, multiDay: true }], dayOf)], [DAY + 1, DAY + 2, DAY + 3]);
});

test('an unroutable leg marks the day, no miles invented', async () => {
  const d = (await planTripDay(input([ev('a', 12, 13, A)], { route: async () => null })))!;
  assert.equal(d.unroutable, true);
  assert.equal(d.miles, 0);
});

test('manualAdjust: the typed day need with the trip margin and floor; raise only above the base', () => {
  assert.deepEqual(manualAdjust({ baseNeedPct: 16, pct: 40 }), { tripPct: 40, needPct: 44, targetPct: 69, raise: true });
  const low = manualAdjust({ baseNeedPct: 16, pct: 10 });
  assert.equal(low.raise, false);
  assert.equal(low.needPct, 16);
  assert.equal(manualAdjust({ baseNeedPct: 10, pct: 95 }).targetPct, 100);
  // Miles: by the day's miles per % (cold days use more) plus parked drain.
  const mild = pctForMiles(120, 70), cold = pctForMiles(120, 30);
  assert.ok(Math.abs(mild - (120 / milesPerPct(70) + 2)) < 1e-9);
  assert.ok(cold > mild);
});
