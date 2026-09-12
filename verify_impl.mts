// Adversarial behavioural fixture for: ev-metrics-raw-endpoint
// Imports the REAL exported buildMetricsRawPayload and drives it under tsx.
// (Hand-authored: the automated drafter is Python-only and cannot emit a .mts
// harness -- it died on FileNotFoundError test_fixture.py. Cases test the
// property directly; each FAILS on the stub (returns {}) and passes on a
// correct impl.)

import { buildMetricsRawPayload as fn, GET } from './app/api/metrics/raw/route.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pjoin } from 'node:path';

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

function join_tmp(): string { return pjoin(tmpdir(), 'evmr-'); }

// helper: run GET() against a temp KEYS_DIR holding the given files, return parsed body.
async function getWith(files: Record<string, unknown>): Promise<any> {
  const dir = mkdtempSync(join_tmp());
  for (const [name, val] of Object.entries(files)) writeFileSync(pjoin(dir, name), JSON.stringify(val));
  const prev = process.env.KEYS_DIR;
  process.env.KEYS_DIR = dir;
  try {
    const res: any = await GET();
    const ct = String(res.headers.get('content-type') || '');
    const body = await res.json();
    return { body, ct, threw: false };
  } catch { return { body: {}, ct: '', threw: true }; }
  finally { if (prev === undefined) delete process.env.KEYS_DIR; else process.env.KEYS_DIR = prev; }
}

// 7. GET integration, VACATION ON: reads every keys/*.json source, honors
//    config vacationMode, returns merged+scrubbed JSON. Exercises the route
//    wiring (readJson per source, config read, sources assembly, Response) --
//    each source line must be a real readJson call, not a benign passthrough.
{
  const r = await getWith({
    'config.json': { vacationMode: true },
    'rivian-state-debug.json': { latitude: 42.1, longitude: -71.2, token: 'abc', soc: 77 },
    'rivian-state.json': { gps: { lat: 1, lon: 2 }, odometer: 12345 },
    'tesla-state.json': { password: 'p', charge: 55 },
    'rivian-parallax.json': { secret: 'zz', ampsRequested: 32 },
    'last-status.json': { location: 'home', ts: 1699 },
  });
  const body = r.body;
  chk('GET: returns json content-type', r.ct.includes('application/json'));
  chk('GET: did not throw', r.threw === false);
  // every source key must be present -- kills "replace readJson call with its first arg"
  chk('GET: rivianRaw source present', !!(body && body.rivianRaw));
  chk('GET: rivianState source present (odometer)', g(body, 'rivianState.odometer') === 12345);
  chk('GET: teslaState source present (charge)', g(body, 'teslaState.charge') === 55);
  chk('GET: parallax source present (ampsRequested)', g(body, 'parallax.ampsRequested') === 32);
  chk('GET: lastStatus source present (ts)', g(body, 'lastStatus.ts') === 1699);
  chk('GET: passthrough scalar kept (soc)', g(body, 'rivianRaw.soc') === 77);
  // vacation on -> location stripped everywhere (recursive)
  chk('GET/vacation: strips latitude', g(body, 'rivianRaw.latitude') === undefined);
  chk('GET/vacation: strips longitude', g(body, 'rivianRaw.longitude') === undefined);
  chk('GET/vacation: strips nested gps', g(body, 'rivianState.gps') === undefined);
  chk('GET/vacation: strips location key', g(body, 'lastStatus.location') === undefined);
  // secrets stripped regardless of vacation
  chk('GET: secret token stripped', g(body, 'rivianRaw.token') === undefined);
  chk('GET: secret password stripped', g(body, 'teslaState.password') === undefined);
  chk('GET: secret secret-key stripped', g(body, 'parallax.secret') === undefined);
}

// 8. GET integration, VACATION OFF (no config.json -> default false): location
//    MUST be preserved. Kills the "vacationMode default false -> true" mutation,
//    which only bites when config is absent.
{
  const r = await getWith({
    'rivian-state-debug.json': { latitude: 42.1, token: 'abc', soc: 77 },
  });
  const body = r.body;
  chk('GET/no-vacation: latitude PRESERVED', g(body, 'rivianRaw.latitude') === 42.1);
  chk('GET/no-vacation: scalar kept (soc)', g(body, 'rivianRaw.soc') === 77);
  chk('GET/no-vacation: secret STILL stripped', g(body, 'rivianRaw.token') === undefined);
}

if (checks < 3) {
  console.log('  SCAFFOLD_INCOMPLETE: only ' + checks + ' chk() case(s); need >= 3.');
  process.exit(1);
}
console.log('--- ' + fails + ' failed ---');
process.exit(fails === 0 ? 0 : 1);
