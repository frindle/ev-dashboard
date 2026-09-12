// Adversarial behavioural fixture for: ev-metrics-influx-lp
//
// Drives the REAL exported buildInfluxLineProtocol from server/telemetry-influx.js
// against a SAVED LIVE payload (sample.json = a real /api/metrics/raw response),
// with secrets INJECTED so the scrub assertion is adversarial, not benign.
//
// CREATION-of-a-new-export: guard the import dynamically so the baseline tree
// (where buildInfluxLineProtocol does not exist yet) FAILS BY REPORT instead of
// crashing at ESM instantiation.

import { readFileSync } from 'fs';

const __mod: any = await import('./server/telemetry-influx.js');
const fn: any = __mod.buildInfluxLineProtocol;
if (typeof fn !== 'function') {
  console.log('FAIL - buildInfluxLineProtocol not exported (baseline / unimplemented)');
  console.log('--- 1 failed ---');
  process.exit(1);
}

let fails = 0;
let checks = 0;
const chk = (name: string, cond: boolean) => {
  checks++;
  console.log((cond ? 'ok - ' : 'FAIL - ') + name);
  if (!cond) fails++;
};

// Live sample -> the 5 sources. Inject secrets to test the scrub adversarially.
const raw = readFileSync(new URL('./sample.json', import.meta.url), 'utf8');
const base = JSON.parse(raw);
const mkSources = () => {
  const s = JSON.parse(JSON.stringify(base));
  s.teslaState = s.teslaState || {};
  s.teslaState.apiToken = 'SECRET_TOK_XYZ';        // secret-named key -> must be scrubbed
  s.parallax = s.parallax || {};
  s.parallax.password = 'SECRET_PW_XYZ';           // secret-named key -> must be scrubbed
  return s;
};
const lineList = (lp: string) => lp.split('\n').filter(Boolean);
const measCount = (lp: string, m: string) => lineList(lp).filter(l => l.startsWith(m + ' ')).length;

// 1. POSITIVE -- all 5 sections present -> a line (one measurement) per section.
{
  const lp = fn(mkSources());
  chk('positive -> non-empty string', typeof lp === 'string' && lp.length > 0);
  chk('ev_rivian_raw section emitted (exactly one line)', measCount(lp, 'ev_rivian_raw') === 1);
  chk('ev_rivian_state section emitted (exactly one line)', measCount(lp, 'ev_rivian_state') === 1);
  chk('ev_tesla_state section emitted (exactly one line)', measCount(lp, 'ev_tesla_state') === 1);
  chk('ev_parallax section emitted (exactly one line)', measCount(lp, 'ev_parallax') === 1);
  chk('ev_last_status section emitted (exactly one line)', measCount(lp, 'ev_last_status') === 1);
}

// 2. FIELD TYPING -- numbers bare, booleans t/f, strings double-quoted.
{
  const lp = fn(mkSources());
  chk('number field emitted bare (batteryLevel.value=58)', lp.includes('batteryLevel.value=58'));
  chk('boolean field emitted as t (isOnline=t)', lp.includes('.isOnline=t'));
  chk('string field double-quoted (chargerState.value="charging_active")',
    lp.includes('chargerState.value="charging_active"'));
}

// 3. SECRET SCRUB (adversarial -- secrets were injected above).
{
  const lp = fn(mkSources());
  chk('secret VALUE apiToken scrubbed', !lp.includes('SECRET_TOK_XYZ'));
  chk('secret KEY apiToken scrubbed', !lp.includes('apiToken'));
  chk('secret VALUE password scrubbed', !lp.includes('SECRET_PW_XYZ'));
  chk('secret KEY password scrubbed', !lp.includes('password'));
}

// 4. OVER-TRIGGER GUARD (vacationMode) -- location dropped one way, kept the other.
{
  const vac = fn(mkSources(), { vacationMode: true });
  chk('vacationMode -> latitude key dropped', !vac.includes('latitude'));
  chk('vacationMode -> longitude value dropped', !vac.includes('-115.2204132'));
  const noVac = fn(mkSources());
  chk('no vacationMode -> latitude present', noVac.includes('latitude=36.0014305'));
}

// 5. SUBSET -- only the sections present are emitted (no phantom measurements).
{
  const lp = fn({ parallax: JSON.parse(JSON.stringify(base)).parallax });
  chk('subset -> ev_parallax present', measCount(lp, 'ev_parallax') === 1);
  chk('subset -> ev_rivian_raw absent', measCount(lp, 'ev_rivian_raw') === 0);
}

// 6. DEGENERATE / EMPTY -- never throw; empty state -> "".
{
  chk('empty object -> ""', fn({}) === '');
  chk('null -> ""', fn(null) === '');
  chk('undefined -> ""', fn(undefined) === '');
  chk('array -> ""', fn([1, 2, 3]) === '');
}

// 7. NO MUTATION -- input sources unchanged after the call.
{
  const s = mkSources();
  const before = JSON.stringify(s);
  fn(s, { vacationMode: true });
  chk('does not mutate input sources', JSON.stringify(s) === before);
}

if (checks < 3) {
  console.log('  SCAFFOLD_INCOMPLETE: only ' + checks + ' chk() case(s); need >= 3.');
  process.exit(1);
}
console.log('--- ' + fails + ' failed ---');
process.exit(fails === 0 ? 0 : 1);
