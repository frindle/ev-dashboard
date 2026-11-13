// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/teslaPlan.test.ts
// Made-up numbers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrivalFloorOf, KW_PER_AMP, needEstimate, sinceHistoryStart, tonightPlan } from './chargePlan.ts';
import { teslaPlanRun, teslaPlannedKw, TESLA_MAX_AMPS, TESLA_MIN_AMPS } from './teslaPlan.ts';

const NOW = Date.parse('2027-02-10T20:00:00-08:00');
const rows = Array.from({ length: 12 }, (_, i) => ({
  startedAt: new Date(NOW - (i + 1) * 86_400_000).toISOString(), energyKwh: 8 + (i % 4),
}));
const vehicle = { historySince: '2027-01-01', arrivalFloorPct: 30, arrivalDriveMargin: 1.2 };
const state = { chargePercent: 40, chargeLimit: 80, isPluggedIn: true };

// What app/api/energy/route.ts computed inline before the move, kept verbatim as the reference.
function legacyRoute(r: typeof rows, v: typeof vehicle, st: typeof state | null, packKwh: number) {
  const est = needEstimate(sinceHistoryStart(r, v.historySince), null, NOW);
  const plan = est === null ? null : tonightPlan({
    dailyKwh: est.plannedKwh, socPct: st?.chargePercent, limitPct: st?.chargeLimit, packKwh,
    minAmps: 5, maxAmps: 48, ...arrivalFloorOf(v),
  });
  return { est, plan };
}

test('/api/energy Tesla plan: identical output before and after the move (fixture)', () => {
  for (const st of [state, { ...state, chargePercent: 10 }, null]) {
    for (const r of [rows, rows.slice(0, 1), []]) {
      const got = teslaPlanRun({ rows: r, vehicle, state: st, packKwh: 75, nowMs: NOW });
      assert.equal(JSON.stringify(got), JSON.stringify(legacyRoute(r, vehicle, st, 75)));
    }
  }
  const full = teslaPlanRun({ rows, vehicle, state, packKwh: 75, nowMs: NOW });
  assert.ok(full.plan && full.plan.tonightAmps >= TESLA_MIN_AMPS && full.plan.tonightAmps <= TESLA_MAX_AMPS);
});

test('teslaPlannedKw: amps x volts when plugged in with a plan; 0 otherwise', () => {
  const run = teslaPlanRun({ rows, vehicle, state, packKwh: 75, nowMs: NOW });
  assert.equal(teslaPlannedKw(run, state), run.plan!.tonightAmps * KW_PER_AMP);
  assert.ok(teslaPlannedKw(run, state) > 0);
  assert.equal(teslaPlannedKw(run, { ...state, isPluggedIn: false }), 0);
  assert.equal(teslaPlannedKw(run, { chargePercent: 40, chargeLimit: 80 }), 0);
  assert.equal(teslaPlannedKw(run, null), 0);
  assert.equal(teslaPlannedKw({ est: null, plan: null }, state), 0);   // no plan
  const full = teslaPlanRun({ rows, vehicle, state: { ...state, chargePercent: 80 }, packKwh: 75, nowMs: NOW });
  assert.equal(teslaPlannedKw({ ...full, plan: { ...full.plan!, tonightKwh: 0, tonightAmps: 5 } }, state), 0);   // nothing to charge
});
