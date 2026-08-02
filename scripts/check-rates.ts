// Self-check for the TOU rate math in lib/rates.ts. This repo has no test
// framework, so this is a plain assert script -- run it with Node's built-in
// TypeScript stripping, from the repo root:
//
//   node scripts/check-rates.ts
//
// Only the pure rate/bucket functions are exercised; the EIA fetch is network
// and cache dependent and is deliberately left out.

import assert from 'node:assert/strict';
import { ratePerKwh, sessionElectricityCostUsd, touBucketFor } from '../lib/rates.ts';

// Expected all-in $/kWh = (base + 0.00274 riders + 0.00039 UEC) * 1.05
const allIn = (base: number) => (base + 0.00274 + 0.00039) * 1.05;
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

// ── bucket selection ──
// Local time is whatever the host is in; construct dates locally on purpose,
// since the rate schedule is defined in local wall-clock terms.
assert.equal(touBucketFor(new Date(2026, 0, 15, 3, 0)), 'winterEvrr', 'Jan 3am = winter EVRR');
assert.equal(touBucketFor(new Date(2026, 0, 15, 9, 0)), 'winter', 'Jan 9am = winter');
assert.equal(touBucketFor(new Date(2026, 0, 15, 19, 0)), 'winter', 'winter has no on-peak window');
assert.equal(touBucketFor(new Date(2026, 6, 15, 3, 0)), 'summerEvrr', 'Jul 3am = summer EVRR');
assert.equal(touBucketFor(new Date(2026, 6, 15, 12, 0)), 'summerOffPeak', 'Jul noon = summer off-peak');
assert.equal(touBucketFor(new Date(2026, 6, 15, 19, 0)), 'summerOnPeak', 'Jul 7pm = summer on-peak');
assert.equal(touBucketFor(new Date(2026, 6, 15, 21, 0)), 'summerOffPeak', '9pm is past on-peak');
assert.equal(touBucketFor(new Date(2026, 6, 15, 7, 59)), 'summerEvrr', 'EVRR runs through 8am');
// Season edges: June 1 is summer, Oct 1 is winter.
assert.equal(touBucketFor(new Date(2026, 5, 1, 19, 0)), 'summerOnPeak', 'Jun 1 is summer');
assert.equal(touBucketFor(new Date(2026, 9, 1, 19, 0)), 'winter', 'Oct 1 is winter');

// ── rate table ──
assert.ok(close(ratePerKwh('winter'), allIn(0.08816)), 'winter rate');
assert.ok(close(ratePerKwh('winterEvrr'), allIn(0.07965)), 'winter EVRR rate');
assert.ok(close(ratePerKwh('summerOnPeak'), allIn(0.47313)), 'summer on-peak rate');
assert.ok(close(ratePerKwh('summerOffPeak'), allIn(0.07463)), 'summer off-peak rate');
assert.ok(close(ratePerKwh('summerEvrr'), allIn(0.06747)), 'summer EVRR rate');
assert.ok(ratePerKwh('summerEvrr') < ratePerKwh('summerOffPeak'), 'EVRR is the cheapest summer bucket');
assert.ok(ratePerKwh('summerOnPeak') > ratePerKwh('winter') * 4, 'summer on-peak is the painful one');

// ── whole-session cost ──
// Entirely inside the summer EVRR window: 10 kWh, 1am-4am.
const evrr = sessionElectricityCostUsd(
  new Date(2026, 6, 15, 1, 0).getTime(), new Date(2026, 6, 15, 4, 0).getTime(), 10);
assert.ok(close(evrr, 10 * ratePerKwh('summerEvrr'), 1e-9), 'all-EVRR session prices at the EVRR rate');

// Straddling the 8am EVRR boundary: 4 kWh over 4h, 6am-10am. Half the
// duration is EVRR, half is summer off-peak, so half the energy each.
const straddle = sessionElectricityCostUsd(
  new Date(2026, 6, 15, 6, 0).getTime(), new Date(2026, 6, 15, 10, 0).getTime(), 4);
const expected = 2 * ratePerKwh('summerEvrr') + 2 * ratePerKwh('summerOffPeak');
assert.ok(close(straddle, expected, 1e-9), 'boundary-straddling session splits across buckets');
assert.ok(straddle > evrr / 10 * 4, 'the straddling half costs more than pure EVRR');

// Degenerate inputs must not produce NaN or throw.
assert.equal(sessionElectricityCostUsd(Date.now(), Date.now(), 0), 0, 'zero kWh costs nothing');
const zeroDuration = sessionElectricityCostUsd(
  new Date(2026, 6, 15, 3, 0).getTime(), new Date(2026, 6, 15, 3, 0).getTime(), 5);
assert.ok(close(zeroDuration, 5 * ratePerKwh('summerEvrr')), 'zero-duration falls back to start-hour rate');

// A session longer than a day must still terminate and stay finite.
const long = sessionElectricityCostUsd(
  new Date(2026, 6, 15, 22, 0).getTime(), new Date(2026, 6, 17, 2, 0).getTime(), 50);
assert.ok(Number.isFinite(long) && long > 0, 'multi-day session is finite');

console.log('lib/rates.ts self-check passed');
