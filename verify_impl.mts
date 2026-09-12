// Adversarial behavioural fixture for: ev-lineprotocol
//
// >>> THE ONE THING THE GENERATOR CANNOT WRITE FOR YOU <<<
//
// The case list is EMPTY and this verify FAILS (SCAFFOLD_INCOMPLETE) until you author >= 3
// real cases below. Deliberate: a generator can emit a verify that
// DISCRIMINATES (red at baseline, green on a fix); it cannot decide whether the
// verify is RELEVANT -- whether it tests the property the task asked for. A
// benign case (flag=true, count=99) passes broken work.
//
// This harness imports the REAL exported pointsToLineProtocol from ./server/influx-line-protocol.js and drives
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

import { pointsToLineProtocol as fn } from './server/influx-line-protocol.js';

let fails = 0;
let checks = 0;
const chk = (name: string, cond: boolean) => {
  checks++;
  console.log((cond ? 'ok - ' : 'FAIL - ') + name);
  if (!cond) fails++;
};

// --- fixture builder -- points are plain objects: { measurement, fields, timestamp? } -----
const pt = (o: Record<string, unknown> = {}) => o as any;

// --- adversarial cases ------------------------------------------------------

// 1) POSITIVE -- the thing the fix must start doing: one point with a numeric
//    field and a timestamp serializes to exactly `<measurement> k=v <tsMs>`.
{
  const r = fn([pt({ measurement: 'cpu', fields: { load: 0.5 }, timestamp: 1620000000000 })]);
  chk('basic point -> "cpu load=0.5 1620000000000"', r === 'cpu load=0.5 1620000000000');
}

// 2) MULTIPLE POINTS -- one line per point, joined by a single "\n", order
//    preserved; booleans -> t/f (never true/false); the second point has NO
//    timestamp so its line must not carry a trailing suffix.
{
  const r = fn([
    pt({ measurement: 'a', fields: { on: true }, timestamp: 1 }),
    pt({ measurement: 'b', fields: { off: false, n: -3.5 } }),
  ]);
  chk('two points -> newline-joined lines in order', r === 'a on=t 1\nb off=f,n=-3.5');
  chk('booleans are t/f, never true/false', !/true|false/.test(r));
}

// 3) STRING VALUES -- double-quoted; embedded " and \ backslash-escaped.
{
  const r = fn([pt({ measurement: 'log', fields: { msg: 'say "hi" \\ path' } })]);
  chk('string value quoted with escaped quote+backslash', r === 'log msg="say \\"hi\\" \\\\ path"');
}

// 4) KEY/MEASUREMENT ESCAPING -- space, comma and '=' in the measurement AND
//    in field keys must be backslash-escaped.
{
  const r = fn([pt({ measurement: 'my cpu,load=x', fields: { 'k v=w': 1 } })]);
  chk('measurement escapes space/comma (not =); key escapes space/comma/=', r === 'my\\ cpu\\,load=x k\\ v\\=w');
}

// 5) OVER-ESCAPE CONTROL -- identifiers WITHOUT special chars must NOT gain
//    backslashes (an over-eager escaper that also hits - _ . fails here).
{
  const r = fn([pt({ measurement: 'cpu', fields: { 'a-b_c.d': 42 } })]);
  chk('no spurious escaping on plain identifiers', r === 'cpu a-b_c.d=42');
}

// 6) BOUNDARY (keep side) -- NaN/Infinity field values are skipped, finite kept.
{
  const r = fn([pt({ measurement: 'm', fields: { good: 1, bad: NaN, inf: Infinity } })]);
  chk('NaN/Infinity fields dropped, finite kept', r === 'm good=1');
}

// 7) BOUNDARY (skip side) -- a point whose fields are ALL unserializable is
//    skipped entirely: empty string, not a blank line.
{
  const r = fn([pt({ measurement: 'm', fields: { a: NaN, b: Infinity } })]);
  chk('all-unserializable point -> "", no blank line', r === '');
}

// 8) NO-FIELDS POINTS -- skipped; a missing `fields` key must not throw.
{
  const r = fn([pt({ measurement: 'x' }), pt({ measurement: 'y', fields: {} }), pt({ measurement: 'z', fields: { v: 1 } })]);
  chk('fieldless points skipped, valid one kept', r === 'z v=1');
}

// 9) TIMESTAMP ABSENT -- the line is exactly `<measurement> k=v`, no trailing space.
{
  const r = fn([pt({ measurement: 't', fields: { a: 1 } })]);
  chk('absent timestamp -> bare "t a=1"', r === 't a=1');
}

// 10) DEGENERATE INPUTS -- empty array / null / undefined / wrong type must
//     return '' and never throw (a throwing impl would crash the sidecar POST).
{
  let threw = false;
  const outs: string[] = [];
  for (const bad of [[], null, undefined, 'nope', {}]) {
    try { outs.push(fn(bad as any)); } catch { threw = true; }
  }
  chk('empty/non-array input never throws', !threw);
  chk("empty/non-array input -> ''", outs.every((s) => s === ''));
}

// 11) REGRESSION -- plain integers emitted as-is, including 0 and negatives.
{
  const r = fn([pt({ measurement: 'g', fields: { zero: 0, neg: -7 } })]);
  chk('integers as-is incl. 0 and negative', r === 'g zero=0,neg=-7');
}

const CASES_AUTHORED = true;
if (!CASES_AUTHORED) {
  console.log('  SCAFFOLD_INCOMPLETE: adversarial cases not yet authored in verify_impl.mts.');
  process.exit(1);
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
