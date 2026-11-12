// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/geocode.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearGeocodeCache, placeEvent, searchPlaces } from './geocode.ts';

const fakeNominatim = (hits: unknown[] = [{ lat: '36.2', lon: '-115.3', display_name: 'A place' }]) => {
  const urls: string[] = [];
  return { urls, impl: async (url: string) => { urls.push(url); return { ok: true, status: 200, json: async () => hits }; } };
};
const env = { NOMINATIM_URL: 'http://nom.invalid:8080/' };

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
  assert.equal(await placeEvent({ ...base, geo: null }, {}, {}, f.impl), null);        // no NOMINATIM_URL
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
