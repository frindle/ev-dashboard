# TASK: ev-influx-dualwrite

## Confirmed defect (observed, not suspected)

Confirmed dead code: `buildInfluxWriteRequest` (`server/telemetry-influx.js:72`,
exported line 95) has ZERO call sites; no `INFLUX_*` env is read anywhere in the
repo; no HTTP POST to InfluxDB ever fires. `writeState`
(`server/telemetry-server.js:117`) writes ONLY `keys/tesla-state.json`
(`fs.writeFileSync`) plus a JSONL push-log. InfluxDB v2.7.12 is live/ready at
`http://10.0.6.61:8086` but receives nothing. The composition layer
(`buildInfluxWriteRequest` -> `buildTelemetryPoints` -> `pointsToLineProtocol`)
exists and is correct; the caller + HTTP POST + env plumbing were never added.

## Entry point

`server/telemetry-server.js:117` -- the `writeState(state)` function (the single
chokepoint every merged telemetry state passes through).

## Required change (edit ONLY `server/telemetry-server.js`)

Add a non-blocking InfluxDB dual-write. Reuse the EXISTING pure composition in
`./telemetry-influx` -- do NOT reimplement flatten/redaction/serialization.

1. **Require the module** near the other requires at the top of the file:
   `const { buildInfluxWriteRequest } = require('./telemetry-influx');`
   (Nothing requires it today; that is the missing wire.)

2. **Add an exported, SELF-CONTAINED helper `maybeWriteInflux(state, opts = {})`**
   (so it is unit-testable without standing up the ws server, and so `writeState`
   can call it on one line with no wrapping). It must NEVER throw and must swallow
   async errors itself:
   ```
   function maybeWriteInflux(state, opts = {}) {
     try {
       const influxUrl = process.env.INFLUX_URL;
       const influxToken = process.env.INFLUX_TOKEN;
       const influxOrg = process.env.INFLUX_ORG;
       const influxBucket = process.env.INFLUX_BUCKET;
       if (!influxUrl || !influxToken || !influxOrg || !influxBucket) return; // any unset -> no-op
       const req = buildInfluxWriteRequest(state, {
         influxUrl, influxToken, influxOrg, influxBucket,
         measurement: process.env.INFLUX_MEASUREMENT, // optional; default ev_telemetry
         vacationMode: opts.vacationMode,
       });
       if (!req) return; // nothing to write (empty body)
       return fetch(req.url, { method: req.method, headers: req.headers, body: req.body })
         .catch((e) => console.error('[telemetry] influx write failed:', e));
     } catch (e) {
       console.error('[telemetry] influx write failed:', e);
     }
   }
   ```
   - Uses the global `fetch` (Node 26 has it). The inner `.catch` swallows async
     failures; the surrounding `try/catch` swallows sync failures.

3. **Call it from `writeState`, AFTER the JSON write.** Keep the existing
   `fs.writeFileSync(STATE_FILE, ...)` first and unchanged, then ONE line:
   ```
   maybeWriteInflux(state, { vacationMode: getVacationMode() });
   ```
   Do NOT `await` it -- a slow/failed Influx must not delay or fail the JSON
   write, and because maybeWriteInflux is self-contained it cannot throw here.

4. **Add `getVacationMode()`** mirroring the existing `getExpectedVin()` (read
   `CONFIG_FILE` = `KEYS_DIR/config.json`, top-level `vacationMode` boolean,
   default `false`, never throw):
   ```
   function getVacationMode() {
     try {
       const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
       return cfg?.vacationMode === true;
     } catch { return false; }
   }
   ```

5. **Guard the server startup so importing the module does NOT stand up the ws
   server.** The bottom `loadProto().then(() => server.listen(...)) ...` block
   currently runs at import time. Wrap it so it only runs when the file is the
   entry point:
   ```
   if (require.main === module) {
     loadProto().then(() => { server.listen(PORT, '0.0.0.0', () => { ... }); })
       .catch((e) => { console.error('[telemetry] failed to start:', e); process.exit(1); });
   }
   ```
   Running `node server/telemetry-server.js` in production is unchanged
   (`require.main === module` is true there); importing it for tests is now
   side-effect-free.

6. **Export the helpers** at the end of the file:
   `module.exports = { writeState, maybeWriteInflux };`
   (There is no existing `module.exports` in this file.)

## Behaviour that must NOT change

- When `INFLUX_*` is unset (the current deploy state), `writeState` must behave
  EXACTLY as today: write `keys/tesla-state.json` and fire NO network request.
- The JSON state file is always written first and is never lost, even when the
  Influx POST throws or the env is unset.
- Do NOT alter flatten/redaction/serialization -- redaction (secret-named keys
  always dropped; lat/lon dropped under `vacationMode`) must survive the wiring
  untouched, via the existing `./telemetry-influx` code.
- Do NOT touch the UI, `/api/dashboard`, or any file other than
  `server/telemetry-server.js`.

## Must contain

- `require('./telemetry-influx')`
- `buildInfluxWriteRequest`
- `maybeWriteInflux`
- `getVacationMode`
- `INFLUX_URL`
- `INFLUX_TOKEN`
- `INFLUX_ORG`
- `INFLUX_BUCKET`
- `fetch(`
- `require.main === module`
- `module.exports`

## Scope

Only edit `server/telemetry-server.js`; do not edit `verify.sh`,
`verify_impl.mts`, `check_literals.py` or `TASK.md`. `verify_impl.mts` is the
test fixture -- changing it invalidates the check.

## Keep every changed line exercised (relevance)

The env reads, the URL/header/body of the POST, the no-op-when-unset branch, the
try/catch survival, and the redaction pass-through are all asserted by
`verify_impl.mts`. Fold any unavoidable constant onto a line the test exercises;
do not emit a lone untested line.

## Loop instruction

Run `bash verify.sh` after every edit and keep editing `server/telemetry-server.js`
until it prints `VERIFY_OK`.
