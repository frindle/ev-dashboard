// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/chargeOverride.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overridePlan, validOverride, windowsBetween } from './chargeOverride.ts';

const at = (local: string) => Date.parse(local);   // ISO with explicit offset
const H = 3_600_000;
const NIGHT = { startMin: 23 * 60, durationMin: 8 * 60 };   // 23:00-07:00
const base = { packKwh: 135, dailyKwh: 18, window: NIGHT, minAmps: 6, maxAmps: 48, limitPct: 70 };

test('validOverride: integer 50..100, deadline in the next 14 days', () => {
  const now = at('2026-11-09T12:00:00-08:00');
  assert.deepEqual(validOverride({ targetPct: 90, byMs: now + H, extra: 1 }, now), { targetPct: 90, byMs: now + H });
  for (const o of [null, {}, { targetPct: 49, byMs: now + H }, { targetPct: 101, byMs: now + H }, { targetPct: 80.5, byMs: now + H },
    { targetPct: 80, byMs: now }, { targetPct: 80, byMs: now + 15 * 24 * H }, { targetPct: '80', byMs: now + H }]) {
    assert.equal(validOverride(o, now), null, JSON.stringify(o));
  }
});

test('windowsBetween: clips to the span, includes a window already running, survives DST', () => {
  assert.equal(process.env.TZ, 'America/Los_Angeles');
  const w = windowsBetween(at('2026-11-10T02:00:00-08:00'), at('2026-11-11T06:00:00-08:00'), NIGHT);
  assert.deepEqual(w.map((x) => (x.endMs - x.startMs) / H), [5, 7]);   // 02-07, then 23-06
  // DST ends 2026-11-01 02:00 PDT: the 23:00 Oct 31 window still starts at local 23:00 and runs 8 real hours.
  const dst = windowsBetween(at('2026-10-31T20:00:00-07:00'), at('2026-11-01T12:00:00-08:00'), NIGHT);
  assert.equal(dst.length, 1);
  assert.equal(dst[0].startMs, at('2026-10-31T23:00:00-07:00'));
  assert.equal((dst[0].endMs - dst[0].startMs) / H, 8);
  assert.deepEqual(windowsBetween(at('2026-11-10T08:00:00-08:00'), at('2026-11-10T22:00:00-08:00'), NIGHT), []);
});

test('overridePlan: tonight only, set late evening -> gap / window hours, limit flagged', () => {
  const p = overridePlan({ ...base, override: { targetPct: 90, byMs: at('2026-11-10T07:00:00-08:00') },
    nowMs: at('2026-11-09T22:59:00-08:00'), socPct: 50 })!;
  assert.equal(p.windows, 1);
  assert.equal(p.hours, 8);
  // 40% of 135 / 0.9 = 60 wall kWh, + 1 minute of the day's driving (negligible)
  assert.ok(Math.abs(p.needKwh - 60) < 0.05, String(p.needKwh));
  assert.equal(p.amps, 32);          // 60 / 1.92 = 31.3 -> 32
  assert.equal(p.feasible, true);
  assert.equal(p.reachablePct, 90);
  assert.equal(p.raiseLimitTo, 90);
});

test('overridePlan: multi-night spreads the gap and adds driving on the days between', () => {
  // Set Mon 07:00 before driving, due Thu 08:00: windows Mon, Tue, Wed nights (24h of charging);
  // driving: all of Monday (16h of the 16h day still ahead) + Tue + Wed = 3 days.
  const p = overridePlan({ ...base, override: { targetPct: 70, byMs: at('2026-11-12T08:00:00-08:00') },
    nowMs: at('2026-11-09T07:00:00-08:00'), socPct: 60 })!;
  assert.equal(p.windows, 3);
  assert.equal(p.hours, 24);
  assert.ok(Math.abs(p.needKwh - (13.5 / 0.9 + 3 * 18)) < 1e-9);
  assert.equal(p.amps, 12);          // 69 / 5.76 = 11.98 -> 12
  assert.equal(p.raiseLimitTo, null);
});

test('overridePlan: infeasible -> maxAmps and the SoC it reaches; expired or SoC unknown -> null', () => {
  const p = overridePlan({ ...base, override: { targetPct: 100, byMs: at('2026-11-10T01:00:00-08:00') },
    nowMs: at('2026-11-09T23:00:00-08:00'), socPct: 30 })!;
  assert.equal(p.feasible, false);
  assert.equal(p.amps, 48);
  assert.ok(Math.abs(p.reachablePct - (30 + (48 * 0.48 * 0.9 / 135) * 100)) < 1e-9);
  // Deadline before the next window: nothing to charge in
  const none = overridePlan({ ...base, override: { targetPct: 80, byMs: at('2026-11-09T20:00:00-08:00') },
    nowMs: at('2026-11-09T12:00:00-08:00'), socPct: 50 })!;
  assert.equal(none.windows, 0);
  assert.equal(none.feasible, false);
  assert.equal(none.reachablePct, 50);
  const o = { targetPct: 80, byMs: at('2026-11-10T07:00:00-08:00') };
  assert.equal(overridePlan({ ...base, override: o, nowMs: o.byMs, socPct: 50 }), null);
  for (const socPct of [null, undefined, 0, NaN]) assert.equal(overridePlan({ ...base, override: o, nowMs: o.byMs - H, socPct }), null);
  // Already above the target: minimum amps, nothing to raise
  const done = overridePlan({ ...base, override: o, nowMs: at('2026-11-09T23:00:00-08:00'), socPct: 85, limitPct: 90 })!;
  assert.equal(done.amps, 6);
  assert.equal(done.raiseLimitTo, null);
});
