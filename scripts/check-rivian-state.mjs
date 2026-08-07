// Self-check for the Rivian charging/throttle derivation in lib/rivian.ts.
// This repo has no test framework, so this is a plain assert script -- run it
// with Node's built-in TypeScript stripping, from the repo root:
//
//   node scripts/check-rivian-state.mjs
//
// It drives the real fetchRivianVehicleState() against a stubbed global fetch
// with realistic vehicleState payloads, so the assertions cover the actual
// mapping code rather than a copy of it. Covers the two bugs this exists for:
//   1. charging + a stale chargerState timeStamp must still read as charging
//      (chargerState's timeStamp is last-*changed*, so it ages out mid-session)
//   2. a numeric chargerDerateStatus must not throw (Rivian sends raw JSON
//      numbers on String-typed fields), and must still resolve isThrottled
//
// .mjs, not .ts, on purpose: tsconfig's include globs only cover **/*.ts, so
// keeping this out of the Next build means the node:module resolve hook below
// doesn't have to type-check against whatever @types/node version is pinned.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerHooks } from 'node:module';

// lib/*.ts import each other extensionlessly (Next's resolver handles it);
// plain Node ESM does not. Teach it the .ts extension before the dynamic
// import below pulls lib/rivian.ts in.
registerHooks({
  resolve(spec, ctx, next) {
    return next(spec.startsWith('.') && !/\.[a-z]+$/.test(spec) ? spec + '.ts' : spec, ctx);
  },
});

const dir = mkdtempSync(join(tmpdir(), 'rivian-check-'));
process.env.KEYS_DIR = dir;
writeFileSync(join(dir, 'rivian-tokens.json'), JSON.stringify({
  accessToken: 'x', refreshToken: 'x', userSessionToken: 'x',
  appSessionToken: 'x', csrfToken: 'x', vehicleId: 'V1', savedAt: Date.now(),
}));

const { fetchRivianVehicleState } = await import('../lib/rivian.ts');

const HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const NOW = new Date().toISOString();

function stubVehicleState(overrides) {
  const vehicleState = {
    cloudConnection: { lastSync: NOW, isOnline: true },
    batteryLevel: { value: 62 },
    distanceToEmpty: { value: 210 },
    batteryLimit: { value: 80 },
    timeToEndOfCharge: { value: 90 },
    vehicleMileage: { value: 43_000_000 },
    ...overrides,
  };
  globalThis.fetch = async () => new Response(
    JSON.stringify({ data: { vehicleState } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

// ── 1. charging + throttled, chargerState timeStamp an hour stale ──────────
// This is the reported bug: card showed "IDLE · PLUGGED IN · NOT CHARGING"
// with no throttle chip while the Rivian app showed charging + throttled.
stubVehicleState({
  chargerState:  { value: 'charging_active', timeStamp: HOUR_AGO },
  chargerStatus: { value: 'chrgr_sts_connected_charging', timeStamp: NOW },
  chargerDerateStatus: { value: 'battery_thermal', timeStamp: NOW },
});
const charging = await fetchRivianVehicleState();
assert.ok(charging, 'expected a state object');
assert.equal(charging.isPluggedIn, true, 'connected_charging must read as plugged in');
assert.equal(charging.isCharging, true, 'stale chargerState must not veto a charging chargerStatus');
assert.equal(charging.isThrottled, true, 'non-idle derate value must read as throttled');
assert.equal(charging.derateReason, 'battery_thermal');

// ── 1b. same, but chargerStatus uses an unknown "connected" literal ────────
// Only `chrgr_sts_not_connected` is confirmed from primary sources, so the
// fix must not hinge on guessing the charging literal: with chargerStatus
// unrecognised, the plug-state veto (not the old clock veto) has to carry it.
stubVehicleState({
  chargerState:  { value: 'charging_active', timeStamp: HOUR_AGO },
  chargerStatus: { value: 'chrgr_sts_some_unknown_connected_value', timeStamp: NOW },
  chargerDerateStatus: { value: 'no_derate', timeStamp: NOW },
});
const unknownStatus = await fetchRivianVehicleState();
assert.ok(unknownStatus);
assert.equal(unknownStatus.isCharging, true, 'plugged in + charging_active is charging regardless of chargerState age');

// ── 1c. stale charging_active but unplugged → NOT charging ────────────────
// The safety the old staleness veto provided, kept: an unplugged car can't
// be charging no matter what a never-updated chargerState still claims.
stubVehicleState({
  chargerState:  { value: 'charging_active', timeStamp: HOUR_AGO },
  chargerStatus: { value: 'chrgr_sts_not_connected', timeStamp: NOW },
});
const staleUnplugged = await fetchRivianVehicleState();
assert.ok(staleUnplugged);
assert.equal(staleUnplugged.isPluggedIn, false);
assert.equal(staleUnplugged.isCharging, false, 'unplugged vetoes a stale charging_active');

// ── 2. numeric derate value (Rivian sends numbers on String fields) ────────
// Before the String() coercion this threw out of the whole function, which
// the caller read as a poll failure and answered with a stale-cache serve.
stubVehicleState({
  chargerState:  { value: 'charging_active', timeStamp: NOW },
  chargerStatus: { value: 'chrgr_sts_connected_charging', timeStamp: NOW },
  chargerDerateStatus: { value: 0, timeStamp: NOW },
  batteryHvThermalEvent: { value: 0, timeStamp: NOW },
});
const numericDerate = await fetchRivianVehicleState();
assert.ok(numericDerate, 'numeric derate value must not throw the poll away');
assert.equal(numericDerate.isCharging, true);
assert.equal(numericDerate.isThrottled, false, 'numeric 0 derate is "not derated"');
assert.equal(numericDerate.hvThermalActive, false, 'numeric 0 thermal is "no event"');

// ── 3. plugged in but not charging (TOU delay) still reads as not charging ─
stubVehicleState({
  chargerState:  { value: 'charging_ready', timeStamp: NOW },
  chargerStatus: { value: 'chrgr_sts_connected_no_chrg', timeStamp: NOW },
  chargerDerateStatus: { value: 'no_derate', timeStamp: NOW },
});
const waiting = await fetchRivianVehicleState();
assert.ok(waiting);
assert.equal(waiting.isPluggedIn, true);
assert.equal(waiting.isCharging, false, 'charging_ready / no_chrg is NOT charging');
assert.equal(waiting.isThrottled, false);

// ── 4. unplugged ──────────────────────────────────────────────────────────
stubVehicleState({
  chargerState:  { value: 'disconnected', timeStamp: NOW },
  chargerStatus: { value: 'chrgr_sts_not_connected', timeStamp: NOW },
});
const unplugged = await fetchRivianVehicleState();
assert.ok(unplugged);
assert.equal(unplugged.isPluggedIn, false);
assert.equal(unplugged.isCharging, false);

console.log('✓ rivian charge/throttle derivation checks passed');
