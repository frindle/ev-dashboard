// Adversarial behavioural fixture for: ev-tesla-capture-all
//
// applyDatum() lives in server/telemetry-server.js, a CommonJS module that
// AUTO-RUNS on import (top-level `loadProto().then(() => server.listen(PORT))`
// with no `require.main` guard, and it is not even exported). So we CANNOT
// `import` it -- doing so would bind port 50051 and read the proto file. Instead
// we read the source as text, slice out the applyDatum function, and eval it in
// a controlled scope where WE supply `fieldNumberToName`. This tests the pure
// field-mapping behaviour with zero side effects and needs no change to the
// target's runtime interface (the fix stays a minimal edit to the default clause).
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dir, 'server', 'telemetry-server.js'), 'utf8');

// Slice from the function declaration to the next top-level statement. The
// `const server = http.createServer` line immediately follows applyDatum's
// closing brace and is a unique, stable end anchor -- more robust than a naive
// brace counter (applyDatum contains template literals with `${...}`).
const startIdx = src.indexOf('function applyDatum');
const endIdx = src.indexOf('const server = http.createServer', startIdx);
if (startIdx < 0 || endIdx < 0) {
  console.log('FAIL - could not locate applyDatum in server/telemetry-server.js');
  process.exit(1);
}
const funcSrc = src.slice(startIdx, endIdx);

// Rebuild applyDatum with `fieldNumberToName` injected as a parameter/closure.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const make = new Function('fieldNumberToName', funcSrc + '\nreturn applyDatum;');

let fails = 0;
let checks = 0;
const chk = (name: string, cond: boolean) => {
  checks++;
  console.log((cond ? 'ok - ' : 'FAIL - ') + name);
  if (!cond) fails++;
};

// key -> canonical Field-enum name. 601 is a KNOWN field (Soc); 9001/9002 are
// deliberately named as fields with NO `case` in the switch; 7777 is absent
// from the map entirely (exercises the `Field${key}` fallback).
const fieldMap = new Map<number, string>([
  [601, 'Soc'],
  [9001, 'BrandNewTeslaField'],
  [9002, 'AnotherUnmappedField'],
]);
const applyDatum = make(fieldMap) as (state: any, key: number, value: any) => void;

// Case 1 (DISCRIMINATOR, red at baseline): an unmapped field is captured raw
// under its canonical name. At baseline the default clause only logs -> dropped.
{
  const s: any = {};
  applyDatum(s, 9001, { doubleValue: 42.5 });
  chk('unmapped field captured under state.raw by canonical name',
    !!s.raw && s.raw.BrandNewTeslaField === 42.5);
}

// Case 2 (OVER-TRIGGER GUARD): a KNOWN field maps to its real state key and must
// NOT leak into state.raw. A wrong fix that captures everything would fail this.
{
  const s: any = {};
  applyDatum(s, 601, { intValue: 55 });
  chk('known field Soc -> state.chargePercent (mapping unchanged)', s.chargePercent === 55);
  chk('known field does NOT populate state.raw', s.raw === undefined);
}

// Case 3 (DEGENERATE GUARD): an unmapped field with no extractable value (v null)
// must not be stored and must not throw.
{
  const s: any = {};
  applyDatum(s, 9002, {}); // no oneof variant present -> v resolves to null
  chk('unmapped field with null value is not stored',
    !s.raw || !('AnotherUnmappedField' in s.raw));
}

// Case 4 (DISCRIMINATOR): a field absent from the enum map falls back to
// `Field<key>` and is still captured.
{
  const s: any = {};
  applyDatum(s, 7777, { stringValue: 'hello' });
  chk('unmapped field with unknown enum name captured as Field<key>',
    !!s.raw && s.raw['Field7777'] === 'hello');
}

// Case 5 (DISCRIMINATOR): multiple unmapped fields accumulate in one raw bucket.
{
  const s: any = {};
  applyDatum(s, 9001, { floatValue: 1 });
  applyDatum(s, 7777, { stringValue: 'x' });
  chk('multiple unmapped fields accumulate in state.raw',
    !!s.raw && s.raw.BrandNewTeslaField === 1 && s.raw['Field7777'] === 'x');
}

if (checks < 3) {
  console.log('  SCAFFOLD_INCOMPLETE: only ' + checks + ' chk() case(s); need >= 3.');
  process.exit(1);
}
console.log('--- ' + fails + ' failed ---');
process.exit(fails === 0 ? 0 : 1);
