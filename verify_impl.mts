// Adversarial behavioural fixture for: ev-circuit-charging-truth
//
// Imports the REAL exported circuitStatus and drives it under tsx. The property:
// a side counts as CHARGING only when BOTH its amps>0 AND that side's vehicle is
// actually charging. Phantom pilot/contactor draw (amps>0 while the car reports
// not-charging) must NOT read as charging; a real charging side must STAY charging;
// and amps>0 is still REQUIRED (a car that reports charging but draws 0 A does not
// count). These cases pin all three directions.

import { circuitStatus as fn } from './lib/circuitStatus.ts';

let fails = 0;
let checks = 0;
const chk = (name: string, cond: boolean) => {
  checks++;
  console.log((cond ? 'ok - ' : 'FAIL - ') + name);
  if (!cond) fails++;
};

// 1. THE BUG (over-trigger guard): both connectors draw phantom amps but neither
//    vehicle is charging -> must NOT say BOTH CHARGING; both plugged -> NOT CHARGING.
{
  const r = fn(10, 10, true, true, false, false);
  chk('phantom amps, neither charging -> NOT the BOTH CHARGING label',
    r.label === 'BOTH PLUGGED IN — NOT CHARGING');
  chk('phantom amps, neither charging -> charging=false', r.charging === false);
}

// 2. REAL both-charging (must STAY charging): both amps>0 AND both charging.
{
  const r = fn(10, 12, true, true, true, true);
  chk('both amps>0 and both charging -> BOTH CHARGING label',
    r.label === 'BOTH CHARGING — WITHIN CIRCUIT LIMIT');
  chk('both amps>0 and both charging -> charging=true', r.charging === true);
}

// 3. ONE genuinely charging, the other idle-plugged.
{
  const r = fn(16, 0, true, true, true, false);
  chk('left amps>0 & charging, right idle -> ONE CONNECTOR CHARGING',
    r.label === 'ONE CONNECTOR CHARGING — WITHIN CIRCUIT LIMIT');
  chk('one real charging -> charging=true', r.charging === true);
}

// 4. MIXED — kills the OR/global-AND wrong fixes: left has phantom amps but is
//    NOT charging; right is genuinely charging. Only the right side counts.
{
  const r = fn(9, 16, true, true, false, true);
  chk('left phantom (amps>0, not charging) + right real -> ONE CONNECTOR CHARGING',
    r.label === 'ONE CONNECTOR CHARGING — WITHIN CIRCUIT LIMIT');
}

// 5. REVERSE guard — amps>0 is still REQUIRED: a side reporting isCharging=true
//    but drawing 0 A must NOT count (kills an "isCharging-only" wrong fix).
{
  const r = fn(0, 0, true, true, true, false);
  chk('charging flag true but 0 A -> does NOT count -> BOTH PLUGGED IN — NOT CHARGING',
    r.label === 'BOTH PLUGGED IN — NOT CHARGING');
  chk('charging flag true but 0 A -> charging=false', r.charging === false);
}

// 6. Fully idle, nothing plugged.
{
  const r = fn(0, 0, false, false, false, false);
  chk('nothing plugged or charging -> IDLE — NOTHING CHARGING',
    r.label === 'IDLE — NOTHING CHARGING');
}

if (checks < 3) {
  console.log('  SCAFFOLD_INCOMPLETE: only ' + checks + ' chk() case(s); need >= 3.');
  process.exit(1);
}
console.log('--- ' + fails + ' failed ---');
process.exit(fails === 0 ? 0 : 1);
