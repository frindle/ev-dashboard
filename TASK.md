# TASK: ev-tesla-rest-capture-all

## Confirmed defect (observed, not suspected)

confirmed via read: fetchVehicleState maps ~20 scalar fields out of the Tesla vehicle_data REST response into TeslaVehicleState and discards every other field returned (all of charge_state/vehicle_state/climate_state beyond the mapped scalars), so those values never reach the cache or /api/metrics/influx -> InfluxDB

## Entry point

lib/tesla.ts:344

## Required change

the returned TeslaVehicleState carries the full parsed vehicle_data response verbatim under a raw field (Record<string,unknown>) so full-fidelity Tesla REST telemetry flows to InfluxDB; every existing typed field maps exactly as before; the requested endpoints string is NOT changed

Behaviour that must NOT change:
- Every existing typed field maps EXACTLY as it does today: chargePercent =
  charge_state.battery_level (?? 0), chargeLimit default 80, isCharging =
  (charging_state === 'Charging'), isPluggedIn = (charging_state !==
  undefined && !== 'Disconnected'), chargerPowerKw = current*voltage/1000,
  online = (data.state === 'online'), otaStatus/otaAvailableVersion/etc. Do
  not rename, reorder-semantically, or alter any of them.
- The requested endpoints string stays EXACTLY
  `endpoints=charge_state%3Bvehicle_state%3Bclimate_state`. It is deliberately
  scope-gated (see the comment at the fetch call): adding drive_state /
  location_data 403s the whole call. Do NOT widen it.
- Missing or empty groups must NOT throw: an empty charge_state/vehicle_state/
  climate_state must still yield the defaults above.
- `raw` must hold the COMPLETE parsed vehicle_data response verbatim (the whole
  `data` object, including any groups the typed mapping ignores, e.g.
  gui_settings / vehicle_config / extra charge_state fields), not a
  hand-rebuilt subset.

## Must contain

- `raw: data`
- `raw?:`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

## Scope

Only edit `lib/tesla.ts`; do not edit `verify.sh`, `verify_impl.mjs` or `TASK.md`.
verify_impl.mjs is the test fixture -- changing it invalidates the check.

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
