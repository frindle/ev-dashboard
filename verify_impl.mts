// Adversarial behavioural fixture for: ev-metrics-raw-endpoint
// Imports the REAL exported buildMetricsRawPayload and drives it under tsx.
// (Hand-authored: the automated drafter is Python-only and cannot emit a .mts
// harness -- it died on FileNotFoundError test_fixture.py. Cases test the
// property directly; each FAILS on the stub (returns {}) and passes on a
// correct impl.)

import { buildMetricsRawPayload as fn } from './app/api/metrics/raw/route.ts';

let fails = 0;
let checks = 0;
const chk = (name: string, cond: boolean) => {
  checks++;
  console.log((cond ? 'ok - ' : 'FAIL - ') + name);
  if (!cond) fails++;
};

// deep-get helper
const g = (o: any, path: string): any => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);

// 1. MERGE: every provided source is represented; non-secret/non-location
//    scalars pass through unchanged. (stub returns {} -> FAILS here)
{
  const src = { a: { soc: 55, name: 'car' }, b: { kwh: 7.6 } };
  const r = fn(src, { vacationMode: false });
  chk('merge: source a present', !!r.a);
  chk('merge: source b present', !!r.b);
  chk('merge: scalar passthrough (soc)', g(r, 'a.soc') === 55);
  chk('merge: scalar passthrough (kwh)', g(r, 'b.kwh') === 7.6);
}

// 2. SECRETS removed in BOTH modes (vacationMode false here).
{
  const src = { t: { token: 'abc', accessToken: 'x', password: 'p', keep: 1 } };
  const r = fn(src, { vacationMode: false });
  chk('secret: token removed (mode off)', g(r, 't.token') === undefined);
  chk('secret: accessToken removed (substring match)', g(r, 't.accessToken') === undefined);
  chk('secret: password removed (mode off)', g(r, 't.password') === undefined);
  chk('secret: non-secret sibling kept', g(r, 't.keep') === 1);
}

// 3. OVER-TRIGGER GUARD: with vacationMode FALSE, location is PRESERVED.
//    A one-directional fix that always strips location breaks this.
{
  const src = { v: { latitude: 42.1, longitude: -71.2, soc: 80 } };
  const r = fn(src, { vacationMode: false });
  chk('guard: latitude preserved when mode OFF', g(r, 'v.latitude') === 42.1);
  chk('guard: longitude preserved when mode OFF', g(r, 'v.longitude') === -71.2);
}

// 4. VACATION MODE: location stripped recursively; non-location kept.
{
  const src = { v: { latitude: 42.1, lon: -71.2, gps: {}, location: 'x', nested: { lat: 1, soc: 90 } } };
  const r = fn(src, { vacationMode: true });
  chk('vacation: latitude removed', g(r, 'v.latitude') === undefined);
  chk('vacation: lon removed', g(r, 'v.lon') === undefined);
  chk('vacation: gps removed', g(r, 'v.gps') === undefined);
  chk('vacation: location removed', g(r, 'v.location') === undefined);
  chk('vacation: nested lat removed (recursive)', g(r, 'v.nested.lat') === undefined);
  chk('vacation: nested non-location kept', g(r, 'v.nested.soc') === 90);
}

// 5. NO MUTATION of inputs (deep clone).
{
  const src: any = { v: { token: 'secret', latitude: 1, soc: 5 } };
  fn(src, { vacationMode: true });
  chk('nomutate: input token still present', src.v.token === 'secret');
  chk('nomutate: input latitude still present', src.v.latitude === 1);
}

// 6. DEGENERATE inputs must not throw and must not crash the merge.
{
  let threw = false;
  let r: any;
  try {
    r = fn({ a: null, b: { x: 1 }, c: undefined as any }, { vacationMode: true });
  } catch { threw = true; }
  chk('degenerate: null/undefined source does not throw', threw === false);
  chk('degenerate: valid sibling still merged', g(r, 'b.x') === 1);
  // empty sources -> empty object
  const e = fn({}, { vacationMode: false });
  chk('degenerate: empty sources -> {}', e && Object.keys(e).length === 0);
}

if (checks < 3) {
  console.log('  SCAFFOLD_INCOMPLETE: only ' + checks + ' chk() case(s); need >= 3.');
  process.exit(1);
}
console.log('--- ' + fails + ' failed ---');
process.exit(fails === 0 ? 0 : 1);
