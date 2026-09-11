# TASK: ev-circuit-status-false-charging (diagnosis)

## Confirmed symptom (observed, not suspected)

CONFIRMED via live /api/dashboard (2026-09-11 ~09:55): BOTH vehicles isCharging=false (rivian chargingState='not_charging', tesla chargingState='5'), both isPluggedIn=true; both wallConnectors currentA=0, powerW=0, vehicleCharging=false (LEFT/Midknight vehicleConnected=false online=true faultState=2; RIGHT/Tesla vehicleConnected=true online=false). Yet the circuit-header intermittently renders GREEN 'BOTH CHARGING — WITHIN CIRCUIT LIMIT' (correct text 'BOTH PLUGGED IN — NOT CHARGING' shows on some polls) and the CHARGERS chip shows '2 / 2 in use'. Intermittent across 30s polls.

## The question to answer

Localize (a) where the circuit-header status string ('BOTH CHARGING — WITHIN CIRCUIT LIMIT' vs 'BOTH PLUGGED IN — NOT CHARGING') is computed and the exact condition deciding charging-vs-plugged-in; (b) where the CHARGERS 'N in use' count is computed. Explain why (a) is charging when isCharging=false for both — which field it keys on (isPluggedIn? wallConnector vehicleConnected/vehicleCharging? chargingState truthiness, e.g. tesla chargingState=='5'?) — and why intermittent. file:line each.

## SEARCH PLAN -- do these IN ORDER, and STOP as soon as you can answer the question

1. Read `REPO_MAP.md` at the repo root FIRST. It has a file->exported-symbols index
   and a "computation digest" (where quantities/counts/totals are summed or reduced).
   Use it to LOCALIZE the relevant code -- do NOT grep blind.
2. From the map, open ONLY the 1-3 files most likely to hold the answer. Read each once.
3. Grep ONLY to CONFIRM a specific location the map pointed you to (e.g. one symbol,
   one file:line) -- never to discover from scratch what the map already lists.
4. As soon as you can name the root cause with a file:line, STOP searching and write
   `DIAGNOSIS.md` immediately. Do not keep exploring "to be thorough".

STOP condition: you have a file:line + a one-paragraph mechanism for the symptom.
Read budget: at most ~8 file reads / greps total. If you approach that, WRITE your
best current finding to DIAGNOSIS.md now rather than reading more.
Do NOT re-grep or re-read a file you have already seen this run -- act on what you found.

## Required output

Write `DIAGNOSIS.md` at the repo root containing:
- Root cause: the file:line where the problem originates, and the mechanism (why).
- Evidence: the specific code/values you saw that prove it (quote them).
- Fix sketch: one paragraph on what change would resolve it (do NOT make the change).
- Falsifiable prediction: one concrete, checkable claim that MUST be true if this
  mechanism is the cause and would be FALSE if it isn't -- something a reviewer can
  confirm against the code or the live data without trusting your reasoning. State
  the exact check (e.g. "row X will have field F = null", "deleting Y drops total by
  Z", "this branch conserves the summed value, so it cannot change the total"). A
  mechanism with no falsifiable prediction is a guess; a wrong mechanism usually
  makes a prediction that the data contradicts, which is how a bad diagnosis is caught.

## Scope

This is a READ-ONLY investigation. Edit ONLY `DIAGNOSIS.md`. Do not modify any source
file, `verify.sh`, `REPO_MAP.md`, or `TASK.md`.

## Loop instruction

Run `bash verify.sh` to confirm DIAGNOSIS.md exists and is non-empty, then stop.
