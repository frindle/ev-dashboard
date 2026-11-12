// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/geocode.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearGeocodeCache, placeEvent, searchPlaces } from './geocode.ts';
import { _setSleepForTests, ONLINE_UA } from './onlineGeo.ts';

const fakeNominatim = (hits: unknown[] = [{ lat: '36.2', lon: '-115.3', display_name: 'A place' }]) => {
  const urls: string[] = [];
  return { urls, impl: async (url: string) => { urls.push(url); return { ok: true, status: 200, json: async () => hits }; } };
};
const env = { NOMINATIM_URL: 'http://nom.invalid:8080/', GEO_ONLINE: '0' };

test('placeEvent order: event geo, then override by UID, then Nominatim, else unplaced', async () => {
  clearGeocodeCache();
  const f = fakeNominatim();
  const base = { uid: 'u1', location: '1 Main St' };
  assert.deepEqual(await placeEvent({ ...base, geo: { lat: 1, lon: 2 } }, { u1: { lat: 9, lon: 9 } }, env, f.impl), { lat: 1, lon: 2, source: 'event' });
  assert.deepEqual(await placeEvent({ ...base, geo: null }, { u1: { lat: 9, lon: 8 } }, env, f.impl), { lat: 9, lon: 8, source: 'override' });
  assert.equal(f.urls.length, 0);
  assert.deepEqual(await placeEvent({ ...base, geo: null }, {}, env, f.impl), { lat: 36.2, lon: -115.3, source: 'nominatim' });
  assert.ok(f.urls[0].startsWith('http://nom.invalid:8080/search?'));
  clearGeocodeCache();
  assert.equal(await placeEvent({ ...base, geo: null }, {}, env, fakeNominatim([]).impl), null);
  assert.equal(await placeEvent({ ...base, geo: null }, {}, { GEO_ONLINE: '0' }, f.impl), null);        // no NOMINATIM_URL, online off
  assert.equal(await placeEvent({ uid: 'x', location: '', geo: null }, {}, env, f.impl), null);
});

test('searchPlaces: several hits, cached, errors give [] and no URL in the log', async () => {
  clearGeocodeCache();
  const f = fakeNominatim([{ lat: '1', lon: '2', display_name: 'One' }, { lat: 'x', lon: '2' }, { lat: '3', lon: '4', display_name: 'Two' }]);
  assert.deepEqual((await searchPlaces('a b', env, f.impl)).map((h) => h.label), ['One', 'Two']);
  await searchPlaces('A B', env, f.impl);
  assert.equal(f.urls.length, 1);
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.join(' ')); };
  try {
    assert.deepEqual(await searchPlaces('zzz', env, async (u) => { throw new Error(`down ${u}`); }), []);
  } finally { console.error = orig; }
  assert.ok(logged.length === 1 && !logged[0].includes('nom.invalid') && !logged[0].includes('zzz'));
});

test('online fallback: only when the LAN copy finds nothing; app User-Agent, US only, source online', async () => {
  clearGeocodeCache();
  _setSleepForTests(async () => {});
  try {
    const seen: { url: string; ua?: string }[] = [];
    const impl = async (url: string, init: { headers?: Record<string, string> }) => {
      seen.push({ url, ua: init.headers?.['User-Agent'] });
      const lan = url.startsWith('http://nom.lan');
      const hits = lan && url.includes('Henderson') ? [{ lat: '36.03', lon: '-114.98', display_name: 'Henderson' }]
        : !lan && url.includes('Bishop') ? [{ lat: '37.36', lon: '-118.39', display_name: 'Bishop, CA' }] : [];
      return { ok: true, status: 200, json: async () => hits };
    };
    const e = { NOMINATIM_URL: 'http://nom.lan:8080', NOMINATIM_ONLINE_URL: 'https://nom.online.invalid' };
    assert.deepEqual(await placeEvent({ uid: 'a', location: 'Henderson', geo: null }, {}, e, impl), { lat: 36.03, lon: -114.98, source: 'nominatim' });
    assert.equal(seen.length, 1);
    assert.deepEqual(await placeEvent({ uid: 'b', location: 'Main St, Bishop CA', geo: null }, {}, e, impl), { lat: 37.36, lon: -118.39, source: 'online' });
    assert.equal(seen.length, 3);
    assert.ok(seen[2].url.startsWith('https://nom.online.invalid/search?') && seen[2].url.includes('countrycodes=us'));
    assert.equal(seen[2].ua, ONLINE_UA);
    assert.equal(seen[1].ua, undefined);
    // A miss on both is cached (retried after 12 h, not every run).
    assert.deepEqual(await searchPlaces('Nowhere at all', e, impl), []);
    const n = seen.length;
    assert.deepEqual(await searchPlaces('Nowhere at all', e, impl), []);
    assert.equal(seen.length, n);
    // Both down: not cached, so the next run asks again.
    const orig = console.error;
    console.error = () => {};
    try {
      const down = async () => { throw new Error('down'); };
      assert.deepEqual(await searchPlaces('Down town', e, down), []);
    } finally { console.error = orig; }
    assert.deepEqual(await searchPlaces('Down town', e, impl), []);
    assert.equal(seen.length, n + 2);
  } finally { _setSleepForTests(null); }
});
