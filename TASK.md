# TASK: ev-metrics-raw-endpoint

## Confirmed defect (observed, not suspected)

confirmed: /api/dashboard/cached is a lossy UI projection (~25 fields). Full raw Tesla/Rivian/Parallax data the app already persists to keys/*.json (e.g. keys/rivian-state-debug.json full raw Rivian) is never exposed for InfluxDB/Telegraf ingestion. Verified this session by curling the cached endpoint (only projected fields present) and by architecture investigation confirming the raw keys/*.json dumps exist unexposed.

## Entry point

app/api/metrics/raw/route.ts:1

## Required change

exported pure helper buildMetricsRawPayload(sources, opts) merges the given raw source objects into one payload; when opts.vacationMode is true it recursively removes all location keys (lat, lon, latitude, longitude, gps, location); it ALWAYS removes secret-named keys (token, secret, password) regardless of vacationMode; input objects are not mutated (deep-cloned).

Behaviour that must NOT change:
- With `opts.vacationMode` FALSE, non-secret location fields are PRESERVED
  (lat/lon of a vehicle still present in the output) -- do not over-scrub.
- Every provided source object is represented in the merged payload (no source
  is dropped); non-location, non-secret fields pass through unchanged.
- The input `sources` object and its nested objects are NOT mutated (return a
  deep clone; the caller's copies must be untouched after the call).
- Secret-named keys (token/secret/password) are removed in BOTH modes.
- The route still `export const dynamic = 'force-dynamic'` and `GET` returns
  JSON.

## Must contain

- in app/api/metrics/raw/route.ts: `latitude`
- in app/api/metrics/raw/route.ts: `password`

(The gate holds the reference impl against this list. A correct implementation
that strips location and secret keys necessarily references these tokens; if the
verify goes green while one is absent, the verify does not enforce the spec.)

## Scope

Only edit `app/api/metrics/raw/route.ts`; do not edit `verify.sh`, `verify_impl.mts` or `TASK.md`.
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
