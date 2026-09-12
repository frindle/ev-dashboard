# TASK: ev-telemetry-influx

## Confirmed defect (observed, not suspected)

confirmed: telemetry-server.js writeState() (line 488) only persists the merged telemetry state to keys/*.json; none of the high-frequency telemetry fields reach InfluxDB, so the TIG stack only sees the lossy /api/dashboard/cached projection Telegraf polls. Verified: no influx dep in package.json and no write path in telemetry-server.js (grep).

## Entry point

server/telemetry-influx.js:16

## Required change

buildTelemetryPoints(state, opts) returns an array of {measurement, fields, timestamp} InfluxDB points: fields is a FLAT dotted-path map of numeric/boolean/non-empty-string leaves (null/undefined and empty containers dropped); opts.vacationMode true recursively drops location keys (lat/lon/latitude/longitude/gps/location); secret keys (token/secret/password) always dropped; input never mutated; timestamp=opts.ts when given.

Behaviour that must NOT change:
- Numeric and boolean leaves survive with their FULL dotted path as the field
  key (e.g. {drivetrain:{soc:77}} -> field `drivetrain.soc` = 77).
- Non-empty strings survive as string fields; null/undefined and empty objects
  or arrays are dropped (Influx has no null field).
- Secret keys (token, secret, password) are ALWAYS dropped, at any depth,
  regardless of vacationMode.
- The input object is never mutated (deep clone / rebuild, never delete-in-place).
- Each returned point has a `measurement` string and a `fields` object; when
  opts.ts is a number it becomes the point's `timestamp`.

## Must contain

- `latitude`
- `password`
- `measurement`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

(A bare bullet checks the default target. To PIN a literal to a specific file --
useful when a fix spans a helper file and the route/wiring that calls it --
prefix the bullet with `in <path>:`, e.g.
`- in app/api/x/route.ts: ` followed by a backtick-quoted token. Then that
token is required in THAT file, not the target.)

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
