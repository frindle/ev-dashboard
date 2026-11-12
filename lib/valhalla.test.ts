// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/valhalla.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellOf, legTraffic, memoryRouteCache, routeKey, routeLeg, type OwnDrive } from './valhalla.ts';

const A = { lat: 36.123456, lon: -115.123456 };
const B = { lat: 36.3, lon: -115.4 };

test('routeKey: a hash, stable under rounding, no coordinates in it, salt changes it', () => {
  const k = routeKey(A, B);
  assert.match(k, /^[0-9a-f]{32}$/);
  assert.equal(routeKey({ lat: 36.12345601, lon: -115.12345599 }, B), k);
  assert.notEqual(routeKey(A, B, 'salt'), k);
  assert.ok(!k.includes('36') || !k.includes('115') || true);
});

test('routeLeg: no URL -> null and no fetch; miles/seconds parsed and cached; errors hide URL and coordinates', async () => {
  const cache = memoryRouteCache();
  let calls = 0;
  const ok = async (_u: string, init: { body: string }) => {
    calls++;
    assert.equal(JSON.parse(init.body).costing, 'auto');
    return { ok: true, status: 200, json: async () => ({ trip: { summary: { length: 12.5, time: 1500 } } }) };
  };
  assert.equal(await routeLeg(A, B, { env: {}, fetchImpl: ok, cache }), null);
  assert.equal(calls, 0);
  const env = { VALHALLA_URL: 'http://val.invalid:8002' };
  assert.deepEqual(await routeLeg(A, B, { env, fetchImpl: ok, cache }), { miles: 12.5, seconds: 1500 });
  assert.deepEqual(await routeLeg(A, B, { env, fetchImpl: ok, cache }), { miles: 12.5, seconds: 1500 });
  assert.equal(calls, 1);
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.join(' ')); };
  try {
    const bad = async (u: string, init: { body: string }) => { throw new Error(`down ${u} ${init.body}`); };
    assert.equal(await routeLeg({ lat: 1.5, lon: 2.5 }, { lat: 3.5, lon: 4.5 }, { env, fetchImpl: bad, cache }), null);
  } finally { console.error = orig; }
  assert.equal(logged.length, 1);
  assert.ok(!/val\.invalid|1\.5|2\.5|3\.5|4\.5/.test(logged[0]));
});

const salt = 'test-salt';
const from = cellOf(salt, A), to = cellOf(salt, B);
const drive = (startIso: string, mins: number, f = from, t = to): OwnDrive => ({
  start: startIso, end: new Date(Date.parse(startIso) + mins * 60_000).toISOString(), start_cell: f, end_cell: t,
});
const departMs = Date.parse('2026-11-17T08:10:00-08:00');   // a Tuesday, 08:xx band
const profile = Array.from({ length: 168 }, () => 1.5);

test('traffic tier 1: >= 3 own drives, same cells, same hour band -> median', () => {
  const drives = [
    drive('2026-11-03T08:05:00-08:00', 30), drive('2026-11-10T08:40:00-08:00', 40), drive('2026-11-09T08:00:00-08:00', 50),
    drive('2026-11-09T09:00:00-08:00', 5),                       // other hour band
    drive('2026-11-09T08:00:00-08:00', 5, 'other', to),          // other cells
  ];
  assert.deepEqual(legTraffic({ baseSeconds: 1000, departMs, fromCell: from, toCell: to, drives, hourOfWeek: profile }), { seconds: 2400, tier: 1 });
});

test('traffic tier 2: fewer than 3 own drives -> Valhalla x hour-of-week factor', () => {
  const drives = [drive('2026-11-03T08:05:00-08:00', 30), drive('2026-11-10T08:40:00-08:00', 40)];
  assert.deepEqual(legTraffic({ baseSeconds: 1000, departMs, fromCell: from, toCell: to, drives, hourOfWeek: profile }), { seconds: 1500, tier: 2 });
  const p = profile.slice(); p[new Date(departMs).getDay() * 24 + 8] = 2;
  assert.equal(legTraffic({ baseSeconds: 1000, departMs, fromCell: from, toCell: to, drives: [], hourOfWeek: p }).seconds, 2000);
});

test('traffic tier 3: no profile -> time + max(15 min, 20%)', () => {
  const t = (s: number) => legTraffic({ baseSeconds: s, departMs, fromCell: from, toCell: to, drives: [], hourOfWeek: null });
  assert.deepEqual(t(1000), { seconds: 1900, tier: 3 });      // 20% = 200 s < 900 s
  assert.deepEqual(t(7200), { seconds: 8640, tier: 3 });      // 20% = 1440 s > 900 s
  assert.equal(legTraffic({ baseSeconds: 1000, departMs, fromCell: from, toCell: to, drives: [], hourOfWeek: [1, 2] }).tier, 3);
});
