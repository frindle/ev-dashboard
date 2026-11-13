// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/noNeedArrival.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrivalPlugAlert, type ArrivalCtx } from './planAlerts.ts';

const end = Date.parse('2026-11-13T17:00:00-08:00');
const ctx = (over: Partial<ArrivalCtx> = {}): ArrivalCtx => ({
  nowMs: end + 20 * 60_000, today: 20000, sent: new Set(), shiftEndsMs: [end], socPct: 62.2,
  decision: { needed: false, requiredPct: 50, reason: null }, override: null, amps: null, raiseLimitTo: null, ...over,
});

test('arrival, no-need night: hold says plugging in will not charge; charge says it tops up at 8A', () => {
  const h = arrivalPlugAlert(ctx({ noNeed: 'hold' }))!;
  assert.equal(h.message, "Home at 62%. Tomorrow is covered; plugging in won't charge tonight (it would raise the daily demand peak).");
  const c = arrivalPlugAlert(ctx({ noNeed: 'charge' }))!;
  assert.equal(c.message, 'Home at 62%. Tomorrow is covered; plugging in tops up at 8A under the forecast peak.');
});

test('arrival: existing wording stays for other cases', () => {
  assert.match(arrivalPlugAlert(ctx())!.message, /Plugging in anyway adds about 11%/);
  assert.match(arrivalPlugAlert(ctx({ noNeed: null }))!.message, /Plugging in anyway adds about 11%/);
  const need = arrivalPlugAlert(ctx({ noNeed: 'hold', decision: { needed: true, requiredPct: 70, reason: 'tomorrow' } }))!;
  assert.match(need.message, /Tomorrow needs 70%/);
  assert.equal(arrivalPlugAlert(ctx({ decision: { needed: null, requiredPct: null, reason: null }, noNeed: 'hold' }))!.title, 'Plug in the Rivian');
});
