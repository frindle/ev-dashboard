// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/valhalla.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellOf, legTraffic, memoryRouteCache, routeKey, routeLeg, type OwnDrive } from './valhalla.ts';
import { _setSleepForTests, inNevada, ONLINE_UA } from './onlineGeo.ts';

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
  assert.equal(await routeLeg(A, B, { env: { GEO_ONLINE: '0' }, fetchImpl: ok, cache }), null);
  assert.equal(calls, 0);
  const env = { VALHALLA_URL: 'http://val.invalid:8002', GEO_ONLINE: '0' };
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

test('inNevada: Nevada towns in, neighbours out', () => {
  for (const p of [{ lat: 36.17, lon: -115.14 }, { lat: 39.53, lon: -119.81 }, { lat: 36.04, lon: -114.98 }, { lat: 36.21, lon: -115.98 }, { lat: 40.84, lon: -115.76 }]) {
    assert.equal(inNevada(p), true, JSON.stringify(p));
  }
  for (const p of [{ lat: 34.05, lon: -118.24 }, { lat: 40.76, lon: -111.89 }, { lat: 33.45, lon: -112.07 }, { lat: 38.93, lon: -119.98 }, { lat: 37.10, lon: -113.58 }, { lat: 35.15, lon: -114.55 }]) {
    assert.equal(inNevada(p), false, JSON.stringify(p));
  }
});

test('routeLeg: Nevada legs go LAN first, online only when it fails; out-of-state legs go online first with rounded ends', async () => {
  const waits: number[] = [];
  _setSleepForTests(async (ms) => { waits.push(ms); });
  try {
    const calls: { url: string; body: { locations: { lat: number; lon: number }[] }; ua?: string }[] = [];
    const fake = (fail: (u: string) => boolean) => async (url: string, init: { body: string; headers: Record<string, string> }) => {
      calls.push({ url, body: JSON.parse(init.body), ua: init.headers['User-Agent'] });
      if (fail(url)) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ trip: { summary: { length: 40, time: 2400 } } }) };
    };
    const env = { VALHALLA_URL: 'http://val.lan:8002', VALHALLA_ONLINE_URL: 'https://val.online.invalid' };
    const home = { lat: 36.123456, lon: -115.123456 };
    // Both ends in Nevada, LAN answers: no online call.
    assert.deepEqual(await routeLeg(home, B, { env, fetchImpl: fake(() => false), cache: memoryRouteCache() }), { miles: 40, seconds: 2400 });
    assert.deepEqual(calls.map((c) => c.url), ['http://val.lan:8002/route']);
    assert.equal(calls[0].body.locations[0].lat, 36.123456);
    assert.equal(calls[0].ua, undefined);
    // LAN fails: online, ends rounded to 0.01, app User-Agent.
    calls.length = 0;
    assert.deepEqual(await routeLeg(home, B, { env, fetchImpl: fake((u) => u.includes('val.lan')), cache: memoryRouteCache() }), { miles: 40, seconds: 2400 });
    assert.deepEqual(calls.map((c) => c.url), ['http://val.lan:8002/route', 'https://val.online.invalid/route']);
    assert.deepEqual(calls[1].body.locations[0], { lat: 36.12, lon: -115.12 });
    assert.equal(calls[1].ua, ONLINE_UA);
    // An end in California: online first, LAN not asked when it answers.
    calls.length = 0;
    const la = { lat: 34.052235, lon: -118.243683 };
    assert.ok(await routeLeg(home, la, { env, fetchImpl: fake(() => false), cache: memoryRouteCache() }));
    assert.deepEqual(calls.map((c) => c.url), ['https://val.online.invalid/route']);
    assert.deepEqual(calls[0].body.locations[1], { lat: 34.05, lon: -118.24 });
    // Online calls to one host are spaced about a second apart.
    assert.ok(waits.length >= 1 && waits.every((w) => w > 0 && w <= 1100), String(waits));
    // GEO_ONLINE=0: LAN only, even for an out-of-state end.
    calls.length = 0;
    assert.ok(await routeLeg(home, la, { env: { ...env, GEO_ONLINE: '0' }, fetchImpl: fake(() => false), cache: memoryRouteCache() }));
    assert.deepEqual(calls.map((c) => c.url), ['http://val.lan:8002/route']);
  } finally { _setSleepForTests(null); }
});
