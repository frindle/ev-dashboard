# TASK: ev-tesla-capture-all

## Confirmed defect (observed, not suspected)

Confirmed by reading the sealed worktree copy of `server/telemetry-server.js`:
`applyDatum()` DOES have a `default:` clause (around line 381), but it only
LOGS the unmapped field under `TELEMETRY_DEBUG` and then DROPS it — it never
stores the value. So any Tesla Fleet-Telemetry Field lacking an explicit
`case` above never reaches `teslaState` (written by `writeState()`), and thus
never reaches `GET /api/metrics/influx` → InfluxDB. This is the single biggest
lossy point in the ingestion path (fetch-scope audit, 2026-09-12).

## Entry point

server/telemetry-server.js:381  (the existing `default:` clause of the `switch (fieldName)` in `applyDatum`)

## Required change

Change the `default:` clause so it CAPTURES the field instead of dropping it:
store the already-extracted value `v` under `state.raw[fieldName]`, where
`fieldName` is the canonical Field-enum name already computed at the top of the
function (`fieldNumberToName.get(key) || \`Field${key}\``). Lazily create the
bucket: `state.raw = state.raw || {}`. This makes every streamed field reach the
cache regardless of whether it has an enumerated `case`.

Behaviour that must NOT change:
- Every existing enumerated `case` still maps to the SAME state key it does now
  (e.g. `Soc`/`BatteryLevel` → `state.chargePercent`). Known fields must NOT be
  written into `state.raw`.
- A null/undefined extracted value `v` is NOT stored (do not create empty/`null`
  raw entries; guard with `if (v !== null && v !== undefined)`).
- The existing `TELEMETRY_DEBUG` console.log in the default clause stays.

## Must contain

- `state.raw = state.raw`
- `state.raw[fieldName]`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not enforce
the spec.)

## Scope

Only edit `server/telemetry-server.js`; do not edit `verify.sh`, `verify_impl.mts` or `TASK.md`.
verify_impl.mts is the test fixture -- changing it invalidates the check.

## Keep every changed line exercised (relevance)

The mutation check flips/deletes each changed line and asks the verify to catch
it. The two capture lines (`state.raw = state.raw || {}` and
`state.raw[fieldName] = v`) are both asserted by the fixture (unmapped fields
appear in `state.raw`; known fields do NOT; null `v` is not stored). Keep the
capture as those two lines inside the `if (v !== null && v !== undefined)` guard.

## Loop instruction

Run `bash verify.sh` after every edit and keep editing until it prints
`VERIFY_OK`.
