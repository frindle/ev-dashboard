# TASK: ev-influx-write-request

## Confirmed defect (observed, not suspected)

confirmed: nothing composes the Influx dual-write request. buildTelemetryPoints (this file) + pointsToLineProtocol (./influx-line-protocol) exist but nothing assembles the /api/v2/write POST (url+headers+body); sidecar writeState() has no Influx write path.

## Entry point

server/telemetry-influx.js:1

## Required change

ADD exported buildInfluxWriteRequest(state,opts) to this file (keep buildTelemetryPoints intact). Returns {url,method:'POST',headers,body} composing buildTelemetryPoints->pointsToLineProtocol, or null when body empty / !influxUrl / !influxToken. url trims one trailing slash on influxUrl then /api/v2/write?org=<enc>&bucket=<enc>&precision=ms; headers Authorization 'Token <token>' + Content-Type 'text/plain; charset=utf-8'. Pure, no I/O, no mutation of state/opts.

Behaviour that must NOT change:
- `buildTelemetryPoints` stays exported and behaviourally unchanged (state flattening,
  secret/location scrubbing, finite-only fields, measurement/ts handling).
- The line-protocol body is produced by `require('./influx-line-protocol').pointsToLineProtocol`
  applied to `buildTelemetryPoints(state, {vacationMode, ts})` -- so vacationMode still drops
  location leaves and secrets are still scrubbed, transitively.
- No network I/O is performed here: this only BUILDS the request object.

## Must contain

- `buildInfluxWriteRequest`
- `buildTelemetryPoints`
- `pointsToLineProtocol`
- `/api/v2/write`
- `precision=ms`
- `encodeURIComponent`
- `Token `
- `text/plain; charset=utf-8`



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
