# TASK: ev-metrics-influx-lp

## Confirmed defect (observed, not suspected)

confirmed: no endpoint emits ALL cached source state as InfluxDB line protocol. /api/metrics/raw (live, 10.0.6.56:3000) exposes 5 sources (rivianRaw, rivianState, teslaState, parallax, lastStatus) as JSON, but nothing serializes the whole set to line protocol for Telegraf-pull ingestion (the chosen transport).

## Entry point

server/telemetry-influx.js:1

## Required change

ADD exported buildInfluxLineProtocol(sources, opts) to this file (keep buildTelemetryPoints + buildInfluxWriteRequest-if-present intact). For each of the 5 known sections present & non-null, call buildTelemetryPoints(section,{vacationMode,ts,measurement}) with per-section measurement (ev_rivian_raw/ev_rivian_state/ev_tesla_state/ev_parallax/ev_last_status), collect points, return require('./influx-line-protocol').pointsToLineProtocol(points). Secrets scrubbed + vacationMode location-drop inherited from buildTelemetryPoints. Empty/no-state -> '' . Pure, no I/O, no mutation.

Behaviour that must NOT change:
- `buildTelemetryPoints` stays exported and behaviourally unchanged (it is REUSED
  here per-section; do not fork its flattening / secret-scrub / vacationMode /
  finite-only logic — call it).
- Per-section flattening + the line protocol come from the EXISTING reviewed
  `buildTelemetryPoints` and `require('./influx-line-protocol').pointsToLineProtocol`.
  Do not re-implement escaping or scrubbing.
- Secret-named keys (token/secret/password) are absent from output; vacationMode
  drops location leaves — both inherited transitively from buildTelemetryPoints.
- No network / no upstream API calls: this serializes state that is PASSED IN.

## Must contain

- `buildInfluxLineProtocol`
- `buildTelemetryPoints`
- `pointsToLineProtocol`
- `ev_rivian_raw`
- `ev_rivian_state`
- `ev_tesla_state`
- `ev_parallax`
- `ev_last_status`



## Scope

Only edit `server/telemetry-influx.js`; do not edit `verify.sh`, `verify_impl.mts` or `TASK.md`.
verify_impl.mts is the test fixture -- changing it invalidates the check.

## Keep every changed line exercised (relevance)

After the job runs, a mutation check flips/deletes each line you changed and
asks the verify to catch it. A changed line whose every mutant survives --
because no test asserts it -- FAILS the gate even when the fix is correct, and
the review never runs. So do NOT emit an isolated, untested line:
- Fold an unavoidable constant onto a line the test already exercises. Put a
  `timeout=` / a `daemon=True` flag / a small tuning number on the SAME line as
  a header dict, URL, or argument the fixture checks -- never on its own line.
- Prefer falling through to an implicit `return None` over a standalone
  `return None` in an `except:` the tests do not assert.
- If a line genuinely cannot be asserted and cannot be folded, it usually
  should not be a separate line at all -- restructure so it isn't.
This is not about adding bogus assertions for constants; it is about not
leaving a lone line that carries no tested behaviour.

## Loop instruction

Run `bash verify.sh` after every edit and keep editing until it prints
`VERIFY_OK`.
