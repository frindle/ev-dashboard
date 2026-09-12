# TASK: ev-lineprotocol

## Confirmed defect (observed, not suspected)

confirmed: Feature B buildTelemetryPoints emits {measurement,fields,timestamp} point objects but nothing serializes them to InfluxDB line protocol, so the telemetry sidecar cannot POST to /api/v2/write. Verified: influx-line-protocol.js is a stub returning ''.

## Entry point

server/influx-line-protocol.js:15

## Required change

pointsToLineProtocol(points) returns InfluxDB line protocol: one line per point '<measurement> k=v,k2=v2 <tsMs>' joined by newlines; measurement and field KEYS escape space/comma/'=' with backslash; string field VALUES double-quoted with embedded quote and backslash escaped; booleans -> t/f; finite numbers as-is; points with no fields skipped; timestamp omitted when absent; empty input -> ''.

Behaviour that must NOT change:
- One line per point, lines joined by a single "\n"; each line is
  `<measurement> <k>=<v>,<k2>=<v2>` with an optional ` <timestampMs>` suffix.
- Numeric field values emitted as-is (finite only); NaN/Infinity field values
  skipped, not stringified.
- Boolean field values serialize to `t` / `f`, never `true`/`false`.
- String field values are double-quoted with embedded `"` and `\` escaped.
- A point whose fields are all unserializable (or empty) is skipped entirely.
- Empty / non-array input returns the empty string, never throws.

## Must contain

- `measurement`
- `timestamp`
- `fields`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

(A bare bullet checks the default target. To PIN a literal to a specific file --
useful when a fix spans a helper file and the route/wiring that calls it --
prefix the bullet with `in <path>:`, e.g.
`- in app/api/x/route.ts: ` followed by a backtick-quoted token. Then that
token is required in THAT file, not the target.)

## Scope

Only edit `server/influx-line-protocol.js`; do not edit `verify.sh`, `verify_impl.mts` or `TASK.md`.
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
