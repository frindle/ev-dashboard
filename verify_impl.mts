// Adversarial behavioural fixture for: ev-telemetry-influx
//
// >>> THE ONE THING THE GENERATOR CANNOT WRITE FOR YOU <<<
//
// The case list is EMPTY and this verify FAILS (SCAFFOLD_INCOMPLETE) until you author >= 3
// real cases below. Deliberate: a generator can emit a verify that
// DISCRIMINATES (red at baseline, green on a fix); it cannot decide whether the
// verify is RELEVANT -- whether it tests the property the task asked for. A
// benign case (flag=true, count=99) passes broken work.
//
// This harness imports the REAL exported buildTelemetryPoints from ./server/telemetry-influx.js and drives
// it. RUN IT UNDER `tsx` (verify.sh does): tsx strips the types and resolves
// the extensionless / `.ts` import that bare `node` CANNOT type-strip through
// a dynamic or static import. A linked git worktree also has no node_modules of
// its own -- verify.sh symlinks the source repo's in; if that is missing, tsx
// will not resolve and the import throws.
//
// Author inputs that separate "did the job" from "made the test go green":
//   - the boundary, and one input on each side of it;
//   - the degenerate inputs (null / missing key / wrong type) that must NOT throw;
//   - at least one input a plausible WRONG fix would get wrong; and
//   - >>> an OVER-TRIGGER GUARD <<< : a case proving the change does NOT fire
//     when it must not -- the real-charging input that must STAY charging, the
//     valid record that must NOT be rejected. A one-directional fix that breaks
//     the opposite direction is the single most common wrong fix; pin it.

import { buildTelemetryPoints as fn } from './server/telemetry-influx.js';

let fails = 0;
let checks = 0;
const chk = (name: string, cond: boolean) => {
  checks++;
  console.log((cond ? 'ok - ' : 'FAIL - ') + name);
  if (!cond) fails++;
};

// --- helpers ---------------------------------------------------------------
// deep-get by dotted path, so a wrong flatten (bad key) reads as undefined.
function g(o: any, path: string): any {
  return path.split('.').reduce((a: any, k: string) => (a == null ? a : a[k]), o);
}
// find the single point (or undefined) returned for a state.
function one(state: any, opts?: any): any {
  const r = fn(state as any, (opts || {}) as any);
  return Array.isArray(r) ? r[0] : undefined;
}

// 1. FLATTEN: nested numeric leaf -> dotted field key, value preserved.
{
  const p = one({ drivetrain: { soc: 77, powerW: 1234 } });
  chk('flatten: nested numeric -> dotted key', g(p, 'fields.drivetrain.soc') === 77);
  chk('flatten: second nested numeric kept', g(p, 'fields.drivetrain.powerW') === 1234);
  chk('flatten: point has measurement string', typeof g(p, 'measurement') === 'string');
}

// 2. TYPES: boolean + non-empty string kept; empty string / null / undefined dropped.
{
  const p = one({ isCharging: true, gear: 'D', note: '', missing: null, gone: undefined, n: 5 });
  chk('types: boolean leaf kept', g(p, 'fields.isCharging') === true);
  chk('types: non-empty string kept', g(p, 'fields.gear') === 'D');
  chk('types: empty string dropped', g(p, 'fields.note') === undefined);
  chk('types: null dropped', !('missing' in (g(p, 'fields') || {})));
  chk('types: undefined dropped', !('gone' in (g(p, 'fields') || {})));
  chk('types: numeric kept alongside', g(p, 'fields.n') === 5);
}

// 3. EMPTY containers produce no field; all-empty state -> [] (no point).
{
  const p = one({ x: {}, y: [], z: 3 });
  chk('empty: empty object yields no field', g(p, 'fields.x') === undefined);
  chk('empty: only real leaf survives', g(p, 'fields.z') === 3);
  const r = fn({ a: {}, b: null } as any, {} as any);
  chk('empty: degenerate state -> [] (no point)', Array.isArray(r) && r.length === 0);
}

// 4. SECRETS always dropped, at any depth, in BOTH modes.
{
  const p = one({ apiToken: 'zzz', nested: { password: 'p', v: 1 }, secretKey: 'q', ok: 2 });
  chk('secret: top-level *token* dropped', g(p, 'fields.apiToken') === undefined);
  chk('secret: nested password dropped', g(p, 'fields.nested.password') === undefined);
  chk('secret: *secret* key dropped', g(p, 'fields.secretKey') === undefined);
  chk('secret: sibling of secret kept', g(p, 'fields.nested.v') === 1);
  // even with vacation OFF, secrets still go
  const p2 = one({ password: 'p', charge: 9 }, { vacationMode: false });
  chk('secret: dropped even when vacation off', g(p2, 'fields.password') === undefined);
  chk('secret: non-secret kept when vacation off', g(p2, 'fields.charge') === 9);
}

// 5. OVER-TRIGGER GUARD: vacation OFF -> location MUST be preserved.
//    (A one-directional fix that always strips location breaks this.)
{
  const p = one({ latitude: 42.1, longitude: -71.2, gps: { lat: 1 }, soc: 55 }, { vacationMode: false });
  chk('guard: vacation off -> latitude PRESERVED', g(p, 'fields.latitude') === 42.1);
  chk('guard: vacation off -> longitude PRESERVED', g(p, 'fields.longitude') === -71.2);
  chk('guard: vacation off -> nested gps PRESERVED', g(p, 'fields.gps.lat') === 1);
}

// 6. VACATION ON -> location stripped recursively; non-location kept.
{
  const p = one({ latitude: 42.1, pos: { lat: 1, gps: { lat: 2 }, alt: 9 }, soc: 5 }, { vacationMode: true });
  chk('vacation: top latitude stripped', g(p, 'fields.latitude') === undefined);
  chk('vacation: nested lat stripped', g(p, 'fields.pos.lat') === undefined);
  chk('vacation: nested gps subtree stripped', g(p, 'fields.pos.gps') === undefined);
  chk('vacation: non-location nested kept (alt)', g(p, 'fields.pos.alt') === 9);
  chk('vacation: non-location scalar kept (soc)', g(p, 'fields.soc') === 5);
}

// 7. NO MUTATION of the input object.
{
  const input: any = { latitude: 1, secret: 's', drivetrain: { soc: 77 } };
  const before = JSON.stringify(input);
  fn(input, { vacationMode: true } as any);
  chk('no-mutation: input unchanged after vacation+secret scrub', JSON.stringify(input) === before);
  chk('no-mutation: secret still present on original', input.secret === 's');
  chk('no-mutation: latitude still present on original', input.latitude === 1);
}

// 8. TIMESTAMP + measurement default/override.
{
  const p = one({ a: 1 }, { ts: 1699999999999 });
  chk('ts: numeric ts becomes point.timestamp', g(p, 'timestamp') === 1699999999999);
  const p2 = one({ a: 1 }, {});
  chk('ts: absent ts -> no timestamp', g(p2, 'timestamp') === undefined);
  const p3 = one({ a: 1 }, { measurement: 'ev_custom' });
  chk('measurement: override honored', g(p3, 'measurement') === 'ev_custom');
}

// 9. DEGENERATE inputs must NOT throw.
{
  let threw = false;
  try { fn(null as any, {} as any); fn(undefined as any, undefined as any); fn(42 as any, {} as any); }
  catch { threw = true; }
  chk('degenerate: null/undefined/scalar state do not throw', threw === false);
  chk('degenerate: null state -> []', Array.isArray(fn(null as any, {} as any)) && fn(null as any, {} as any).length === 0);
}

// Structural floor -- matches the Python/Swift `>= 3` discipline. Deleting the
// guard above with zero chk() calls would otherwise leave fails=0 and go green
// (a vacuous verify). Nothing enforces a case count for us, so count here.
if (checks < 3) {
  console.log('  SCAFFOLD_INCOMPLETE: only ' + checks + ' chk() case(s); need >= 3.');
  process.exit(1);
}
console.log('--- ' + fails + ' failed ---');
process.exit(fails === 0 ? 0 : 1);
