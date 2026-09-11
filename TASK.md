# TASK: ev-circuit-charging-truth

## Confirmed defect (observed, not suspected)

confirmed: circuit header renders 'BOTH CHARGING — WITHIN CIRCUIT LIMIT' while both vehicles report isCharging=false and both wall-connector currentA=0 on the live /api/dashboard snapshot. chargingCount at circuitStatus.ts:11 keys only on amps>0, so phantom pilot/contactor draw or a stale cached live_status power reading flips the header green even though neither car is charging.

## Entry point

lib/circuitStatus.ts:11

## Required change

A side counts as charging only when BOTH its amps>0 AND that side's vehicle is actually charging. Add two boolean params leftCharging,rightCharging; chargingCount = (leftAmps>0 && leftCharging ?1:0) + (rightAmps>0 && rightCharging ?1:0). pluggedCount/label ladder and return shape unchanged.

Behaviour that must NOT change:
- A side that IS genuinely charging (amps>0 AND its vehicle charging) must still
  count — `fn(10,12,true,true,true,true)` stays `'BOTH CHARGING — WITHIN CIRCUIT LIMIT'`.
- `amps>0` is still REQUIRED: a side reporting charging but drawing 0 A must NOT
  count. Do not switch to keying on the charging flag alone.
- The pluggedCount computation, the label ladder, and the `{ label, charging }`
  return shape (with `charging` = `chargingCount > 0`) are unchanged.

## Must contain

- `leftCharging`
- `rightCharging`

## Scope

Only edit `lib/circuitStatus.ts`; do not edit `verify.sh`, `verify_impl.mts` or `TASK.md`.
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
