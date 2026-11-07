// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/chargePlan.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ampsFor, ARRIVAL_DRIVE_MARGIN, ARRIVAL_FLOOR_PCT, dailyUseSeries, ewmaDailyKwh, KWH_PER_AMP, localDayNumber, needEstimate, nextUseDay, tonightPlan, useDayNumber, workOffRates,
} from './chargePlan.ts';

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

test('nextUseDay: the day the coming 00:00-08:00 charge is for', () => {
  assert.equal(nextUseDay(Date.parse('2026-11-09T22:00:00-08:00')), day('2026-11-10'));   // tonight -> tomorrow
  assert.equal(nextUseDay(Date.parse('2026-11-10T03:00:00-08:00')), day('2026-11-10'));   // window running -> today
  assert.equal(nextUseDay(Date.parse('2026-11-10T07:59:00-08:00')), day('2026-11-10'));
  assert.equal(nextUseDay(Date.parse('2026-11-10T08:00:00-08:00')), day('2026-11-11'));   // window over -> tomorrow
  assert.equal(localDayNumber(Date.parse('2026-11-10T23:59:00-08:00')), day('2026-11-10'));
});

// Charging every night, using 20 kWh on work days and 12 on off days; work on
// Mon/Tue/Thu (Nov 2026: the 2nd is a Monday).
function shiftMonth() {
  const work = new Set<number>();
  const sessions = [night('2026-10-31', 15)];
  for (let i = 1; i <= 28; i++) {
    const date = `2026-11-${String(i).padStart(2, '0')}`;
    const isWork = [1, 2, 4].includes(new Date(Date.parse(date + 'T12:00:00-08:00')).getDay());
    if (isWork) work.add(day(date));
    sessions.push(night(date, isWork ? 20 : 12));
  }
  return { work, sessions };
}

test('workOffRates: recovers the two rates, also from sessions every few days', () => {
  const { work, sessions } = shiftMonth();
  const r = workOffRates(sessions, work, day('2026-11-29'))!;
  assert.ok(Math.abs(r.workKwh - 20) < 1e-9 && Math.abs(r.offKwh - 12) < 1e-9, JSON.stringify(r));
  // The same driving, charged only on Sundays and Wednesdays: lumps spread over 3-4 days
  const lumps = [night('2026-10-31', 15)];
  let acc = 0;
  for (let i = 1; i <= 28; i++) {
    const date = `2026-11-${String(i).padStart(2, '0')}`;
    acc += work.has(day(date)) ? 20 : 12;
    const dow = new Date(Date.parse(date + 'T12:00:00-08:00')).getDay();
    if (dow === 0 || dow === 3) { lumps.push(night(date, acc)); acc = 0; }
  }
  const l = workOffRates(lumps, work, day('2026-11-29'))!;
  assert.ok(Math.abs(l.workKwh - 20) < 1e-9 && Math.abs(l.offKwh - 12) < 1e-9, JSON.stringify(l));
});

test('workOffRates: null without enough of each kind of day', () => {
  const { sessions } = shiftMonth();
  assert.equal(workOffRates(sessions, new Set(), day('2026-11-29')), null);                       // no work days
  const all = new Set(Array.from({ length: 40 }, (_, i) => day('2026-10-25') + i));
  assert.equal(workOffRates(sessions, all, day('2026-11-29')), null);                             // no off days
  assert.equal(workOffRates(sessions.slice(0, 3), new Set([day('2026-11-02')]), day('2026-11-03')), null);
});

test('needEstimate: raises to the work rate before a work day, never lowers', () => {
  const { work, sessions } = shiftMonth();
  const ewma = ewmaDailyKwh(sessions)!;
  assert.ok(ewma > 12 && ewma < 20, String(ewma));
  // Sun Nov 29 evening: Mon the 30th is a work day (add it to the calendar)
  work.add(day('2026-11-30'));
  const before = needEstimate(sessions, work, Date.parse('2026-11-29T21:00:00-08:00'))!;
  assert.equal(before.nextDayWork, true);
  assert.ok(Math.abs(before.plannedKwh - 20) < 1e-6, JSON.stringify(before));
  // Tue Dec 1 is off: stays at the EWMA, not the lower off rate
  const off = needEstimate(sessions, work, Date.parse('2026-11-30T21:00:00-08:00'))!;
  assert.equal(off.nextDayWork, false);
  assert.equal(off.plannedKwh, ewma);
  // No calendar -> EWMA, no rates
  assert.deepEqual(needEstimate(sessions, null, Date.parse('2026-11-29T21:00:00-08:00')),
    { ewmaKwh: ewma, rates: null, nextDayWork: null, plannedKwh: ewma });
  assert.equal(needEstimate([night('2026-11-01', 40)], work, Date.now()), null);
});

test('tonightPlan: arrival floor raises tonight only when the catch-up would get home under it', () => {
  const base = { dailyKwh: 20.6, packKwh: 135, minAmps: 6, maxAmps: 48, arrivalFloorPct: ARRIVAL_FLOOR_PCT };
  const dayPct = 20.6 * ARRIVAL_DRIVE_MARGIN * 0.9 / 135 * 100;          // planned day + 10%: 15.1% of the pack
  const arrival = (p: { tonightKwh: number }, soc: number) => soc + p.tonightKwh * 0.9 / 135 * 100 - dayPct;
  // Low limit, nearly empty: catch-up gets home (after a +10% day) at ~21%, floor lifts it to 25%
  const low = tonightPlan({ ...base, socPct: 5, limitPct: 55 });
  assert.ok(Math.abs(low.floorKwh! - (25 + dayPct - 5) / 100 * 135 / 0.9) < 1e-9);
  assert.equal(low.tonightKwh, low.floorKwh);
  assert.ok(Math.abs(arrival(low, 5) - 25) < 1e-9);
  assert.equal(low.tonightAmps, 28);                                       // catch-up alone: 26A
  assert.equal(tonightPlan({ ...base, arrivalFloorPct: undefined, socPct: 5, limitPct: 55 }).tonightAmps, 26);
  // Normal night: catch-up is already above the floor
  const ok = tonightPlan({ ...base, socPct: 45, limitPct: 70 });
  assert.ok(ok.tonightKwh > ok.floorKwh! && arrival(ok, 45) > 40);
  // Floor + a big day above the limit: capped at the limit (= the whole gap)
  const cap = tonightPlan({ ...base, dailyKwh: 40, socPct: 20, limitPct: 50 });
  assert.ok(Math.abs(cap.floorKwh! - cap.gapKwh!) < 1e-9);
  assert.equal(cap.tonightKwh, cap.gapKwh);
  // SoC unknown: no floor
  assert.equal(tonightPlan({ ...base, socPct: null, limitPct: 70 }).floorKwh, null);
});
