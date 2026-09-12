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

import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// KEYS_DIR is read at module load -> set BEFORE importing the target.
const KEYS = mkdtempSync(join(tmpdir(), 'ev-influx-verify-'));
process.env.KEYS_DIR = KEYS;
const STATE_FILE = join(KEYS, 'tesla-state.json');

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
let fetchMode: 'ok' | 'throw' = 'ok';
const realFetch = (globalThis as any).fetch;
(globalThis as any).fetch = (url: any, opts: any) => {
  calls.push({ url: String(url), opts: opts || {} });
  if (fetchMode === 'throw') throw new Error('simulated influx outage');
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

// ---- Case 4: redaction preserved through the wiring ----------------------
{
  calls = [];
  fetchMode = 'ok';
  setEnv({
    INFLUX_URL: 'http://10.0.6.61:8086',
    INFLUX_TOKEN: 'tok-abc123',
    INFLUX_ORG: 'org',
    INFLUX_BUCKET: 'bucket',
  });
  const SECRET = 'SUPERSECRETVALUE';
  const state = {
    chargePercent: 90,
    apiToken: SECRET,                 // secret-named key -> ALWAYS dropped
    location: { lat: 12.3456, lon: 65.4321 }, // dropped under vacationMode
  };
  await Promise.resolve(mod.maybeWriteInflux(state, { vacationMode: true })).catch(() => {});
  chk('case4: a POST still fires with non-secret fields present', calls.length === 1);
  const body = String((calls[0]?.opts || {}).body || '');
  chk('case4: non-secret field survives (chargePercent=90)', body.includes('chargePercent=90'));
  chk('case4: secret value is NOT in the body', !body.includes(SECRET));
  chk('case4: secret key name is NOT in the body', !body.toLowerCase().includes('apitoken'));
  chk('case4: lat value redacted under vacationMode', !body.includes('12.3456'));
  chk('case4: lon value redacted under vacationMode', !body.includes('65.4321'));
}

(globalThis as any).fetch = realFetch;
try { rmSync(KEYS, { recursive: true, force: true }); } catch {}

if (checks < 3) {
  console.log('  SCAFFOLD_INCOMPLETE: only ' + checks + ' chk() case(s); need >= 3.');
  process.exit(1);
}
console.log('--- ' + fails + ' failed ---');
process.exit(fails === 0 ? 0 : 1);
