// Adversarial expression-extraction fixture for: ev-tesla-rest-capture-all
//
// >>> THE ONE THING THE GENERATOR CANNOT WRITE FOR YOU <<<
//
// The case list is guarded off (CASES_AUTHORED = false) and this verify FAILS
// (SCAFFOLD_INCOMPLETE) until you author >= 3 real cases below and flip it. Deliberate: a
// generator can emit a verify that DISCRIMINATES (red at baseline, green on a
// fix); it cannot decide whether the verify is RELEVANT -- whether it tests the
// property the task asked for. A benign case passes broken work.
//
// HOW THIS WORKS (no import): it reads lib/tesla.ts as text, finds the unique
// ANCHOR literal, captures the enclosing single-brace { ... } JS expression,
// and builds `new Function(...PARAMS)` from its body. That reaches inline JSX /
// a config or object literal / a ternary that no module exports.
//
// LIMIT: the brace matcher is depth-counting and NOT string-aware -- an
// expression whose own string/template literals contain a literal { or } will
// mis-slice. Anchor on an expression without braces-in-strings (the common
// case), or extend extractExpr to skip quoted spans.
//
// Author inputs that separate "did the job" from "made the test go green":
//   - the boundary, and one input on each side of it;
//   - the degenerate inputs (missing key / wrong type) that must NOT throw;
//   - at least one input a plausible WRONG fix would get wrong; and
//   - >>> an OVER-TRIGGER GUARD <<< : a case proving the change does NOT fire
//     when it must not (the input that must keep the OLD branch). A
//     one-directional fix that breaks the opposite direction is the single most
//     common wrong fix; pin it.

import * as fs from 'node:fs';

const TARGET = './lib/tesla.ts';
const ANCHOR = "chargePercent: cs.battery_level";   // a UNIQUE literal that sits INSIDE the target expression

// --- extraction: the enclosing { ... } around the anchor, brace-balanced ----
function extractExpr(src, anchor) {
  const at = src.indexOf(anchor);
  if (at < 0) throw new Error('anchor not found in ' + TARGET + ': ' + anchor);
  if (src.indexOf(anchor, at + anchor.length) >= 0)
    throw new Error('anchor is not unique in ' + TARGET + ': ' + anchor);
  // walk BACK to the { that opens the enclosing group (brace-depth aware)
  let i = at, depth = 0;
  for (; i >= 0; i--) {
    const c = src[i];
    if (c === '}') depth++;
    else if (c === '{') { if (depth === 0) break; depth--; }
  }
  if (i < 0) throw new Error('no enclosing { before anchor in ' + TARGET);
  // walk FORWARD to its matching }
  let j = i, d = 0;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '{') d++;
    else if (c === '}') { if (--d === 0) break; }
  }
  if (j >= src.length) throw new Error('no matching } after anchor in ' + TARGET);
  return src.slice(i + 1, j).trim();
}

const SRC = fs.readFileSync(TARGET, 'utf8');
let EXPR;
try {
  EXPR = extractExpr(SRC, ANCHOR);
} catch (e) {
  // Extraction failure is a hard FAIL, never a skip: if the anchor moved or the
  // braces do not balance, the verify certifies nothing and must say so.
  console.log('  FAIL - extraction: ' + e.message);
  process.exit(1);
}

// --- the parameters the expression reads. AUTHOR THIS to match the target. ---
// Order matters: evalExpr(...args) binds positionally to these names.
// The extracted expression is fetchVehicleState's `return { ... }` object.
// It reads these locals (bind positionally): evalExpr(cs, vs, cls, ds, su, otaStatus, data)
//   cs  = data.charge_state    vs = data.vehicle_state   cls = data.climate_state
//   ds  = data.drive_state     su = vs.software_update    otaStatus = su.status ?? ''
//   data = the FULL parsed vehicle_data response (the fix adds `raw: data` to the object)
// Sample driver:
//   const data = { state:'online',
//     charge_state:{ battery_level:57, charge_limit_soc:80, charging_state:'Charging',
//                    charger_actual_current:16, charger_voltage:240, charge_energy_added:12.3 },
//     vehicle_state:{ locked:true, odometer:1234, software_update:{status:'',version:''} },
//     climate_state:{ is_climate_on:false },
//     gui_settings:{ gui_distance_units:'mi/hr' } };   // gui_settings is UNMAPPED -> must land in raw
//   const cs=data.charge_state, vs=data.vehicle_state, cls=data.climate_state,
//         ds=data.drive_state ?? {}, su=vs.software_update ?? {}, otaStatus=su.status ?? '';
//   const obj = evalExpr(cs, vs, cls, ds, su, otaStatus, data);
//   // obj.raw must deep-equal `data` (verbatim, incl. gui_settings); obj.chargePercent===57; etc.
const PARAMS = ['cs', 'vs', 'cls', 'ds', 'su', 'otaStatus', 'data'];
function evalExpr(...args) {
  const fn = new Function(...PARAMS, 'return (' + EXPR + ');');   // eslint-disable-line no-new-func
  return fn(...args);
}

let fails = 0;
let checks = 0;
const chk = (name, cond) => {
  checks++;
  console.log((cond ? 'ok - ' : 'FAIL - ') + name);
  if (!cond) fails++;
};

// --- adversarial cases (authored) --------------------------------------------
// Driver: bind the locals exactly as fetchVehicleState does before its return,
// then eval the extracted object expression. Throws are captured so a
// degenerate input reads as a FAILED case, not a crashed fixture.
function run(data) {
  try {
    const cs = data.charge_state ?? {};
    const vs = data.vehicle_state ?? {};
    const cls = data.climate_state ?? {};
    const ds = data.drive_state ?? {};
    const su = vs.software_update ?? {};
    const otaStatus = su.status ?? '';
    return evalExpr(cs, vs, cls, ds, su, otaStatus, data);
  } catch (e) {
    return { __threw: String((e && e.message) || e) };
  }
}
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Full-fidelity sample. gui_settings / vehicle_config are groups the typed
// mapping never reads; charge_energy_added is an unmapped extra INSIDE
// charge_state. A wrong fix that rebuilds `raw` from only the mapped scalars
// drops all three of these.
const FULL = {
  state: 'online',
  charge_state: { battery_level: 57, charge_limit_soc: 90, charging_state: 'Charging',
                  charger_actual_current: 16, charger_voltage: 240, charge_energy_added: 12.3 },
  vehicle_state: { locked: false, odometer: 1234, software_update: { status: '', version: '' } },
  climate_state: { is_climate_on: true },
  gui_settings: { gui_distance_units: 'mi/hr' },
  vehicle_config: { car_type: 'model3' },
};

// 1. POSITIVE -- the fix's whole point: raw carries the COMPLETE parsed
//    response verbatim (same reference), not a copy or a hand-rebuilt subset.
chk('raw is the full parsed response verbatim (same object)',
    (() => { const o = run(FULL); return !('__threw' in o) && o.raw === FULL; })());

// 2. ANTI-REBUILD GUARD -- raw keeps groups/fields the typed mapping ignores.
chk('raw retains unmapped gui_settings + extra charge_state field',
    (() => { const o = run(FULL); return !('__threw' in o) && deepEq(o.raw, FULL)
      && o.raw.gui_settings?.gui_distance_units === 'mi/hr'
      && o.raw.charge_state?.charge_energy_added === 12.3; })());

// 3. DEGENERATE -- empty groups: defaults hold, no throw, raw still intact.
chk('empty charge/vehicle/climate state -> defaults, no throw, raw intact',
    (() => { const d = { state: 'offline', charge_state: {}, vehicle_state: {}, climate_state: {} };
      const o = run(d);
      return !('__threw' in o) && o.raw === d && o.chargePercent === 0
        && o.chargeLimit === 80 && o.isCharging === false && o.isPluggedIn === false
        && o.chargerPowerKw === 0 && o.online === false; })());

// 4. MISSING groups entirely (data = {}): must not throw, defaults + raw={}.
chk('no state groups at all -> defaults, no throw, raw is the empty object',
    (() => { const d = {}; const o = run(d);
      return !('__threw' in o) && o.raw === d && o.chargePercent === 0
        && o.isLocked === true && o.climateOn === false && o.otaStatus === ''; })());

// 5. BOUNDARY -- 'Charging': the one state that sets isCharging; both flags on.
chk("charging_state 'Charging' -> isCharging AND isPluggedIn",
    (() => { const d = { charge_state: { charging_state: 'Charging' } }; const o = run(d);
      return !('__threw' in o) && o.isCharging === true && o.isPluggedIn === true; })());

// 6. OVER-TRIGGER GUARD -- plugged-in states that are NOT charging, and the
//    one state (Disconnected) where isPluggedIn must be false. A sloppy fix
//    that aliases the two flags passes case 5 but fails these.
chk("charging_state 'Complete' -> plugged in but NOT charging",
    (() => { const d = { charge_state: { charging_state: 'Complete' } }; const o = run(d);
      return !('__threw' in o) && o.isCharging === false && o.isPluggedIn === true; })());
chk("charging_state 'Disconnected' -> neither flag",
    (() => { const d = { charge_state: { charging_state: 'Disconnected' } }; const o = run(d);
      return !('__threw' in o) && o.isCharging === false && o.isPluggedIn === false; })());

// 7. REGRESSION -- typed mapping unchanged when raw is added (preservation).
chk('typed fields map exactly as before on the full sample',
    (() => { const o = run(FULL); return !('__threw' in o)
      && o.chargePercent === 57 && o.chargeLimit === 90 && o.isLocked === false
      && o.climateOn === true && o.odometer === 1234 && o.online === true
      && o.chargerPowerKw === (16 * 240) / 1000; })());

// 8. REGRESSION -- chargeLimit default 80 only when absent; chargerPowerKw 0
//    with one leg missing; 'offline' -> not online.
chk('defaults: chargeLimit 80, power 0 with one leg missing, offline',
    (() => { const d = { state: 'offline', charge_state: { charger_actual_current: 16 } };
      const o = run(d); return !('__threw' in o) && o.chargeLimit === 80
        && o.chargerPowerKw === 0 && o.online === false; })());

// 9. REGRESSION -- OTA mapping: 'installing' sets both flags, '' sets neither.
chk('otaStatus installing -> otaInstalling+available; empty -> neither',
    (() => { const a = run({ vehicle_state: { software_update: { status: 'installing', version: '2024.26.7' } } });
      const b = run({ vehicle_state: { software_update: {} } });
      return !('__threw' in a) && a.otaInstalling === true && a.otaUpdateAvailable === true
        && a.otaAvailableVersion === '2024.26.7'
        && !('__threw' in b) && b.otaInstalling === false && b.otaUpdateAvailable === false; })());

const CASES_AUTHORED = true;
if (!CASES_AUTHORED) {
  console.log('  SCAFFOLD_INCOMPLETE: adversarial cases not yet authored in verify_impl.mjs.');
  console.log('  extracted expression was: ' + EXPR);
  process.exit(1);
}

// Structural floor -- matches the Python/Swift `>= 3` discipline. Flipping
// CASES_AUTHORED with zero chk() calls would otherwise leave fails=0 and go
// green (a vacuous verify). Count and fail short of 3.
if (checks < 3) {
  console.log('  SCAFFOLD_INCOMPLETE: only ' + checks + ' chk() case(s); need >= 3.');
  process.exit(1);
}
console.log('--- ' + fails + ' failed ---');
process.exit(fails === 0 ? 0 : 1);
