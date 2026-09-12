// Adversarial behavioural fixture for: ev-influx-dualwrite
//
// Drives the REAL exported maybeWriteInflux + writeState from
// ./server/telemetry-server.js. The module is CommonJS and, at BASELINE, runs
// its ws-server startup (loadProto().then(server.listen)) at import time -- the
// FIX must guard that behind `require.main === module` so importing it here is
// side-effect-free. We use a DYNAMIC import AFTER setting KEYS_DIR (read at
// module-load) and force process.exit at the end so any stray handle can't hang
// the run. At baseline maybeWriteInflux is not exported -> the first case fails
// -> the whole verify fails (correct: the wiring does not exist yet).
//
// Cases (baseline unwired MUST fail 1,3,4; case 2 pins the safe no-op path):
//   1. all four INFLUX_* env set  -> exactly one POST to
//      ${URL}/api/v2/write?org=<org>&bucket=<bucket>&precision=ms, header
//      "Authorization: Token <token>", line-protocol body w/ ev_telemetry + a
//      known flattened field.
//   2. an INFLUX_* var missing    -> NO POST, and the JSON state file is still
//      written by writeState (over-trigger guard: must NOT fire when unconfigured).
//   3. fetch throws               -> writeState still writes JSON and does NOT
//      throw (telemetry path survives an Influx outage).
//   4. redaction preserved        -> secret-named key value + vacationMode lat/lon
//      are absent from the emitted body; a non-secret field survives.

import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// KEYS_DIR is read at module load -> set BEFORE importing the target.
const KEYS = mkdtempSync(join(tmpdir(), 'ev-influx-verify-'));
process.env.KEYS_DIR = KEYS;
const STATE_FILE = join(KEYS, 'tesla-state.json');
const CONFIG_FILE = join(KEYS, 'config.json');
const setVacationConfig = (on: boolean | null) => {
  // null -> no config file at all (getVacationMode hits its catch -> false)
  if (on === null) { try { rmSync(CONFIG_FILE, { force: true }); } catch {} return; }
  writeFileSync(CONFIG_FILE, JSON.stringify({ vacationMode: on, vehicles: { tesla: { vin: 'X' } } }));
};

// Clean INFLUX_* out of the ambient env so a case controls them fully.
for (const k of ['INFLUX_URL', 'INFLUX_TOKEN', 'INFLUX_ORG', 'INFLUX_BUCKET', 'INFLUX_MEASUREMENT']) {
  delete (process.env as Record<string, string | undefined>)[k];
}

const mod: any = await import('./server/telemetry-server.js');

let fails = 0;
let checks = 0;
const chk = (name: string, cond: boolean) => {
  checks++;
  console.log((cond ? 'ok - ' : 'FAIL - ') + name);
  if (!cond) fails++;
};

// --- fetch capture --------------------------------------------------------
type Call = { url: string; opts: any };
let calls: Call[] = [];
let fetchMode: 'ok' | 'throw' | 'reject' = 'ok';
const realFetch = (globalThis as any).fetch;
(globalThis as any).fetch = (url: any, opts: any) => {
  calls.push({ url: String(url), opts: opts || {} });
  if (fetchMode === 'throw') throw new Error('simulated influx outage (sync)');
  if (fetchMode === 'reject') return Promise.reject(new Error('simulated influx outage (async)'));
  return Promise.resolve({ ok: true, status: 204, text: async () => '' });
};

const setEnv = (o: Record<string, string | undefined>) => {
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) delete (process.env as any)[k];
    else (process.env as any)[k] = v;
  }
};
const clearInflux = () =>
  setEnv({ INFLUX_URL: undefined, INFLUX_TOKEN: undefined, INFLUX_ORG: undefined, INFLUX_BUCKET: undefined });

const hdr = (opts: any, name: string): string => {
  const h = opts && opts.headers;
  if (!h) return '';
  if (typeof h.get === 'function') return String(h.get(name) || '');
  // plain object -- case-insensitive lookup
  for (const k of Object.keys(h)) if (k.toLowerCase() === name.toLowerCase()) return String(h[k]);
  return '';
};

// sanity: the export must exist (fails cleanly at baseline)
chk('maybeWriteInflux is exported as a function', typeof mod.maybeWriteInflux === 'function');
chk('writeState is exported as a function', typeof mod.writeState === 'function');

// ---- Case 1: fully configured -> one correct POST ------------------------
{
  calls = [];
  fetchMode = 'ok';
  setEnv({
    INFLUX_URL: 'http://10.0.6.61:8086',
    INFLUX_TOKEN: 'tok-abc123',
    INFLUX_ORG: 'my org',       // exercises URL-encoding of org
    INFLUX_BUCKET: 'ev/bucket', // exercises URL-encoding of bucket
  });
  const state = { chargePercent: 42, isCharging: true, model: 'Model 3' };
  await Promise.resolve(mod.maybeWriteInflux(state, {})).catch(() => {});
  chk('case1: exactly one POST fired', calls.length === 1);
  const c = calls[0] || ({} as Call);
  chk(
    'case1: URL is ${INFLUX_URL}/api/v2/write?org=<enc>&bucket=<enc>&precision=ms',
    c.url === 'http://10.0.6.61:8086/api/v2/write?org=my%20org&bucket=ev%2Fbucket&precision=ms',
  );
  chk('case1: method POST', String((c.opts || {}).method || '').toUpperCase() === 'POST');
  chk('case1: Authorization: Token <token>', hdr(c.opts, 'Authorization') === 'Token tok-abc123');
  const body = String((c.opts || {}).body || '');
  chk('case1: body carries the ev_telemetry measurement', body.includes('ev_telemetry'));
  chk('case1: body carries a known flattened field (chargePercent=42)', body.includes('chargePercent=42'));
}

// ---- Case 2: a var missing -> NO POST, JSON still written ----------------
{
  calls = [];
  fetchMode = 'ok';
  setEnv({
    INFLUX_URL: 'http://10.0.6.61:8086',
    INFLUX_TOKEN: 'tok-abc123',
    INFLUX_ORG: 'org',
    INFLUX_BUCKET: undefined, // one of four missing
  });
  try { rmSync(STATE_FILE, { force: true }); } catch {}
  mod.writeState({ chargePercent: 55 });
  chk('case2: NO POST fired when a required INFLUX_* var is unset', calls.length === 0);
  chk('case2: JSON state file still written', existsSync(STATE_FILE));
  let ok = false;
  try { ok = JSON.parse(readFileSync(STATE_FILE, 'utf-8')).state.chargePercent === 55; } catch {}
  chk('case2: JSON state file has the written state', ok);
}

// ---- Case 3: fetch throws -> writeState survives, JSON still written -----
{
  calls = [];
  fetchMode = 'throw';
  setEnv({
    INFLUX_URL: 'http://10.0.6.61:8086',
    INFLUX_TOKEN: 'tok-abc123',
    INFLUX_ORG: 'org',
    INFLUX_BUCKET: 'bucket',
  });
  try { rmSync(STATE_FILE, { force: true }); } catch {}
  let threw = false;
  try { mod.writeState({ chargePercent: 77 }); } catch { threw = true; }
  chk('case3: writeState does NOT throw when the Influx POST throws', threw === false);
  chk('case3: JSON state file still written despite Influx failure', existsSync(STATE_FILE));
  let ok = false;
  try { ok = JSON.parse(readFileSync(STATE_FILE, 'utf-8')).state.chargePercent === 77; } catch {}
  chk('case3: JSON state file has the written state despite Influx failure', ok);
}

// Redaction goes through writeState (not maybeWriteInflux directly) so that
// getVacationMode()'s config-read is exercised: writeState passes
// { vacationMode: getVacationMode() } and getVacationMode reads config.json.
const SECRET = 'SUPERSECRETVALUE';
const mkRedactState = () => ({
  chargePercent: 90,
  apiToken: SECRET,                          // secret-named key -> ALWAYS dropped
  location: { lat: 12.3456, lon: 65.4321 },  // dropped ONLY under vacationMode
});
const influxOn = () =>
  setEnv({ INFLUX_URL: 'http://10.0.6.61:8086', INFLUX_TOKEN: 'tok-abc123', INFLUX_ORG: 'org', INFLUX_BUCKET: 'bucket' });

// ---- Case 4: vacationMode ON via config -> lat/lon + secret redacted ------
{
  calls = [];
  fetchMode = 'ok';
  influxOn();
  setVacationConfig(true);
  mod.writeState(mkRedactState());
  chk('case4: a POST fires (vacation on) with non-secret fields present', calls.length === 1);
  const body = String((calls[0]?.opts || {}).body || '');
  chk('case4: non-secret field survives (chargePercent=90)', body.includes('chargePercent=90'));
  chk('case4: secret value is NOT in the body', !body.includes(SECRET));
  chk('case4: secret key name is NOT in the body', !body.toLowerCase().includes('apitoken'));
  chk('case4: lat value redacted under vacationMode', !body.includes('12.3456'));
  chk('case4: lon value redacted under vacationMode', !body.includes('65.4321'));
}

// ---- Case 5: vacationMode OFF (no config) -> lat/lon PRESENT, secret still
//      dropped. Pins getVacationMode(): a one-directional over-redaction fix
//      (always-true) would wrongly strip lat/lon here. ----------------------
{
  calls = [];
  fetchMode = 'ok';
  influxOn();
  setVacationConfig(null); // absent config -> getVacationMode() returns false
  mod.writeState(mkRedactState());
  chk('case5: a POST fires (vacation off)', calls.length === 1);
  const body = String((calls[0]?.opts || {}).body || '');
  chk('case5: lat PRESENT when vacationMode is off', body.includes('12.3456'));
  chk('case5: lon PRESENT when vacationMode is off', body.includes('65.4321'));
  chk('case5: secret value STILL dropped regardless of vacationMode', !body.includes(SECRET));
}

// ---- Case 5b: vacationMode explicitly false in config -> lat/lon PRESENT.
//      Pins getVacationMode's `=== true` (config present, value false). -----
{
  calls = [];
  fetchMode = 'ok';
  influxOn();
  setVacationConfig(false);
  mod.writeState(mkRedactState());
  const body = String((calls[0]?.opts || {}).body || '');
  chk('case5b: a POST fires with vacationMode:false in config', calls.length === 1);
  chk('case5b: lat PRESENT when config vacationMode is false', body.includes('12.3456'));
  chk('case5b: secret STILL dropped', !body.includes(SECRET));
}

// ---- Case 7: async Influx rejection -> writeState survives, rejection is
//      HANDLED (no unhandledRejection), JSON still written. Pins the fire-and
//      -forget .catch attachment. ----------------------------------------
{
  calls = [];
  fetchMode = 'reject';
  influxOn();
  setVacationConfig(null);
  try { rmSync(STATE_FILE, { force: true }); } catch {}
  let unhandled = false;
  const onUnhandled = () => { unhandled = true; };
  process.on('unhandledRejection', onUnhandled);
  let threw = false;
  try { mod.writeState({ chargePercent: 33 }); } catch { threw = true; }
  await new Promise((r) => setTimeout(r, 40)); // let the rejection settle
  process.off('unhandledRejection', onUnhandled);
  chk('case7: writeState does not throw on async Influx rejection', threw === false);
  chk('case7: async Influx rejection is handled (no unhandledRejection)', unhandled === false);
  chk('case7: JSON state file still written despite async Influx rejection', existsSync(STATE_FILE));
}

// ---- Case 6: configured but empty/unserializable state -> NO POST, no throw
//      Pins the `if (!req) return` guard: buildInfluxWriteRequest returns null
//      for an empty body; firing fetch(null.url) would throw. ---------------
{
  calls = [];
  fetchMode = 'ok';
  influxOn();
  let threw = false;
  try { await Promise.resolve(mod.maybeWriteInflux({}, {})).catch(() => {}); } catch { threw = true; }
  chk('case6: empty state -> NO POST (null request short-circuits)', calls.length === 0);
  chk('case6: empty state -> does not throw', threw === false);
}

(globalThis as any).fetch = realFetch;
try { rmSync(KEYS, { recursive: true, force: true }); } catch {}

if (checks < 3) {
  console.log('  SCAFFOLD_INCOMPLETE: only ' + checks + ' chk() case(s); need >= 3.');
  process.exit(1);
}
console.log('--- ' + fails + ' failed ---');
process.exit(fails === 0 ? 0 : 1);
