// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/chargePlan.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ampsFor, dailyUseSeries, ewmaDailyKwh, KWH_PER_AMP, tonightPlan, useDayNumber } from './chargePlan.ts';

const day = (iso: string) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86_400_000);
// 23:00 local (PST, UTC-8) on the given date
const night = (date: string, kwh: number) => ({ startedAt: new Date(Date.parse(date + 'T23:00:00-08:00')).toISOString(), energyKwh: kwh });

test('useDayNumber: before 06:00 local counts for the previous day', () => {
  assert.equal(process.env.TZ, 'America/Los_Angeles');
  assert.equal(useDayNumber('2026-11-03T07:00:00Z'), day('2026-11-02')); // 23:00 Nov 2 local
  assert.equal(useDayNumber('2026-11-03T13:00:00Z'), day('2026-11-02')); // 05:00 Nov 3 local
  assert.equal(useDayNumber('2026-11-03T15:00:00Z'), day('2026-11-03')); // 07:00 Nov 3 local
  assert.equal(useDayNumber('nope'), null);
});

test('dailyUseSeries: spreads each session over the days since the previous one, max 7', () => {
  const s = dailyUseSeries([night('2026-11-01', 10), night('2026-11-04', 30), night('2026-11-04', 6)])!;
  assert.equal(s.firstDay, day('2026-11-01'));
  assert.deepEqual(s.use, [10, 12, 12, 12]);
  const long = dailyUseSeries([night('2026-10-01', 5), night('2026-10-21', 70)])!;
  assert.equal(long.use.length, 21);
  assert.equal(long.use.slice(1, 14).every(x => x === 0), true);   // 13 days beyond the 7-day spread stay 0
  assert.deepEqual(long.use.slice(14), new Array(7).fill(10));
  assert.equal(dailyUseSeries([]), null);
  assert.equal(dailyUseSeries([{ startedAt: 'x', energyKwh: 5 }, night('2026-11-01', -1), night('2026-11-01', NaN)]), null);
});

test('ewmaDailyKwh: null until two use-days, constant use converges to itself, follows a change', () => {
  assert.equal(ewmaDailyKwh([night('2026-11-01', 40)]), null);
  const steady = Array.from({ length: 30 }, (_, i) => night(`2026-10-${String(i + 1).padStart(2, '0')}`, 20));
  assert.ok(Math.abs(ewmaDailyKwh(steady)! - 20) < 1e-9);
  // 2 weeks at 20/day then a week at 10/day: 7-day half-life -> halfway there
  const shift = [...steady.slice(0, 14), ...Array.from({ length: 7 }, (_, i) => night(`2026-10-${15 + i}`, 10))];
  const m = ewmaDailyKwh(shift)!;
  assert.ok(m > 14 && m < 16, String(m));
});

test('ampsFor: 2A steps rounded up, clamped', () => {
  assert.equal(ampsFor(0), 0);
  assert.equal(ampsFor(KWH_PER_AMP * 10), 10);
  assert.equal(ampsFor(KWH_PER_AMP * 10.01), 12);
  assert.equal(ampsFor(1, 5), 5);
  assert.equal(ampsFor(500, 5, 48), 48);
  assert.equal(ampsFor(-3, 6), 6);
});

test('tonightPlan: need plus half the gap beyond it; gap unknown -> need only', () => {
  const base = { dailyKwh: 17.7, packKwh: 135, minAmps: 6, maxAmps: 48 };
  const p = tonightPlan({ ...base, socPct: 48.6, limitPct: 70 });
  assert.ok(Math.abs(p.gapKwh! - 28.89 / 0.9) < 0.01);              // pack kWh -> wall kWh
  assert.ok(Math.abs(p.tonightKwh - (17.7 + (28.89 / 0.9 - 17.7) / 2)) < 0.01);
  assert.equal(p.tonightAmps, 14);   // 24.9 kWh / 1.92 = 13.0A -> next 2A step
  const full = tonightPlan({ ...base, socPct: 70, limitPct: 70 });
  assert.equal(full.gapKwh, 0);
  assert.equal(full.tonightKwh, 17.7);
  assert.equal(tonightPlan({ ...base, socPct: 80, limitPct: 70 }).gapKwh, 0);
  for (const socPct of [null, undefined, 0, NaN]) {
    const u = tonightPlan({ ...base, socPct, limitPct: 70 });
    assert.equal(u.gapKwh, null);
    assert.equal(u.tonightKwh, 17.7);
  }
  assert.equal(tonightPlan({ dailyKwh: 2, packKwh: 82, minAmps: 5, maxAmps: 48, socPct: 79, limitPct: 80 }).tonightAmps, 5);
});
