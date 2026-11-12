// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/tripAlerts.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tripAlerts, type TripAlertCtx, type TripSummary } from './tripAlerts.ts';
import { tripPlanLine } from './tripInflux.ts';

const TODAY = Math.round(Date.UTC(2026, 10, 17) / 86_400_000);
const day = (x: Partial<TripSummary> = {}): TripSummary => ({
  day: TODAY + 1, dateLabel: 'Wed 11/18', miles: 140, needPct: 56, targetPct: 81, byMs: new Date(2026, 10, 18, 7, 30).getTime(),
  raise: true, multiDay: false, unplaced: 0, overlaps: 0, limitPct: 70, reachable: true, ...x,
});
const ctx = (d: TripSummary[], x: Partial<TripAlertCtx> = {}): TripAlertCtx => ({
  nowMs: new Date(2026, 10, 17, 10, 0).getTime(), today: TODAY, serveDay: TODAY, sent: new Set(), days: d, openBefore: [],
  dashboardUrl: 'http://dash.lan:3000/', slot: null, ...x,
});

test('planned + limit nudge + unreachable, each once; link is /trips?day=', () => {
  const a = tripAlerts(ctx([day({ reachable: false })]));
  assert.deepEqual(a.map((x) => x.key.split(':')[0]), ['trip-planned', 'trip-limit', 'trip-unreachable']);
  assert.match(a[0].message, /140 mi, 81% by/);
  assert.equal(a[0].link?.url, `http://dash.lan:3000/trips?day=${TODAY + 1}`);
  const sent = new Set(a.map((x) => x.key));
  assert.equal(tripAlerts(ctx([day()], { sent })).length, 0);
});

test('no limit nudge under the limit; nothing for a trip that does not raise the plan', () => {
  assert.ok(!tripAlerts(ctx([day({ targetPct: 60 })])).some((x) => x.key.startsWith('trip-limit')));
  assert.equal(tripAlerts(ctx([day({ raise: false })])).length, 0);
});

test('multi-day and unplaced (daytime only)', () => {
  assert.ok(tripAlerts(ctx([day({ multiDay: true })])).some((x) => x.key.startsWith('trip-multiday')));
  assert.ok(tripAlerts(ctx([day({ unplaced: 2, raise: false })])).some((x) => x.key.startsWith('trip-unplaced')));
  const night = new Date(2026, 10, 17, 23, 30).getTime();
  assert.ok(!tripAlerts(ctx([day({ unplaced: 1, raise: false })], { nowMs: night })).some((x) => x.key.startsWith('trip-unplaced')));
});

test('overlap: first push daytime, 23:00 reminder, 08:15 reminder, then a fixed push', () => {
  const o = day({ day: TODAY, overlaps: 1, raise: false });
  assert.deepEqual(tripAlerts(ctx([o])).map((x) => x.key), [`trip-overlap:${TODAY}`]);
  const night = new Date(2026, 10, 17, 23, 5).getTime();
  const n = tripAlerts(ctx([o], { nowMs: night, slot: 'update' })).map((x) => x.key);
  assert.ok(n.includes(`trip-overlap:${TODAY}`) && n.includes(`trip-overlap-2300:${TODAY}:${TODAY}`));
  const morning = new Date(2026, 10, 17, 8, 20).getTime();
  assert.ok(tripAlerts(ctx([o], { nowMs: morning, sent: new Set([`trip-overlap:${TODAY}`]) })).some((x) => x.key.startsWith('trip-overlap-0815')));
  const fixed = tripAlerts(ctx([day({ day: TODAY, raise: false })], { openBefore: [TODAY] }));
  assert.deepEqual(fixed.map((x) => x.key), [`trip-overlap-fixed:${TODAY}`]);
});

test('privacy: push text and Influx line carry no title, place or coordinates', () => {
  const secret = /Clinic|Main St|36\.1|-115\./;
  const all = tripAlerts(ctx([day({ multiDay: true, unplaced: 1, overlaps: 1, reachable: false })], { slot: 'update' }));
  assert.ok(all.length >= 4);
  for (const a of all) assert.ok(!secret.test(JSON.stringify(a)), a.message);
  const line = tripPlanLine({ day: TODAY, miles: 140.123, pct: 56.4, target: 81, byMs: 1_700_000_000_000 });
  assert.match(line, /^ev_trip_plan day=\d+,miles=140\.12,pct=56\.4,target=81,by_ms=1700000000000 \d+$/);
  assert.equal(tripPlanLine({ day: TODAY, miles: 1, pct: 1, target: 1, byMs: null }).includes('by_ms'), false);
});
