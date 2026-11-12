// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/rivianDailyUse.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDailyUse, localDate, type UseCharge, type UseDrive } from './rivianDailyUse.ts';

// Local (Pacific) times, written as offsets so the test doesn't depend on DST.
const at = (date: string, hh: number) => new Date(`${date}T${String(hh).padStart(2, '0')}:00:00-08:00`).toISOString();
const charge = (d1: string, h1: number, d2: string, h2: number, s: number | null, e: number | null): UseCharge =>
  ({ start: at(d1, h1), end: at(d2, h2), start_soc: s, end_soc: e });
const drive = (d: string, h: number, s: number, e: number, miles = 10): UseDrive => ({ start: at(d, h), start_soc: s, end_soc: e, miles });

test('two charges 3 days apart: drive drops per day, parked drain split evenly', () => {
  // charge ends 2026-01-10 06:00 at 70%; next starts 2026-01-13 02:00 at 40%.
  // total drop 30; drives 8 (Jan 10) + 6 + 10 (Jan 11) + 3 (Jan 12) = 27; parked 3 over Jan 10..13 = 4 days.
  const charges = [charge('2026-01-09', 1, '2026-01-10', 6, 40, 70), charge('2026-01-13', 2, '2026-01-13', 6, 40, 80)];
  const drives = [
    drive('2026-01-10', 9, 70, 62, 20), drive('2026-01-11', 8, 62, 56, 12), drive('2026-01-11', 17, 56, 46, 25), drive('2026-01-12', 12, 46, 43, 6),
  ];
  const rows = computeDailyUse(drives, charges, null);
  const by = Object.fromEntries(rows.map((r) => [r.date, r]));
  assert.deepEqual(rows.map((r) => r.date), ['2026-01-10', '2026-01-11', '2026-01-12', '2026-01-13']);
  assert.equal(by['2026-01-10'].drive_pct, 8);
  assert.equal(by['2026-01-11'].drive_pct, 16);
  assert.equal(by['2026-01-11'].drives, 2);
  assert.equal(by['2026-01-11'].miles, 37);
  assert.equal(by['2026-01-12'].drive_pct, 3);
  assert.equal(by['2026-01-13'].drive_pct, 0);
  for (const r of rows) assert.equal(r.parked_pct, 0.75);
  assert.equal(by['2026-01-11'].used_pct, 16.75);
  assert.equal(by['2026-01-10'].unknown, false);
});

test('days with no polls make their segment unknown', () => {
  const charges = [charge('2026-01-09', 1, '2026-01-10', 6, 40, 70), charge('2026-01-13', 2, '2026-01-13', 6, 40, 80)];
  const polled = new Set(['2026-01-10', '2026-01-12', '2026-01-13']);   // Jan 11 has no polls
  const rows = computeDailyUse([drive('2026-01-10', 9, 70, 62)], charges, polled);
  assert.equal(rows.length, 4);
  for (const r of rows) { assert.equal(r.unknown, true); assert.equal(r.used_pct, null); }
});

test('all days polled: known', () => {
  const charges = [charge('2026-01-09', 1, '2026-01-10', 6, 40, 70), charge('2026-01-11', 2, '2026-01-11', 6, 40, 80)];
  const polled = new Set(['2026-01-10', '2026-01-11']);
  const rows = computeDailyUse([], charges, polled);
  assert.ok(rows.every((r) => !r.unknown && r.used_pct !== null));
});

test('gaps over 7 days are dropped', () => {
  const charges = [charge('2026-01-01', 1, '2026-01-01', 6, 40, 70), charge('2026-01-10', 2, '2026-01-10', 6, 20, 80)];
  assert.deepEqual(computeDailyUse([], charges, null), []);
  const ok = [charge('2026-01-01', 1, '2026-01-01', 6, 40, 70), charge('2026-01-08', 5, '2026-01-08', 6, 20, 80)];
  assert.ok(computeDailyUse([], ok, null).length > 0);
});

test('a charge elsewhere in between (SoC went up) drops the segment; missing SoC skips it', () => {
  assert.deepEqual(computeDailyUse([], [charge('2026-01-01', 1, '2026-01-01', 6, 40, 50), charge('2026-01-03', 2, '2026-01-03', 6, 60, 80)], null), []);
  assert.deepEqual(computeDailyUse([], [charge('2026-01-01', 1, '2026-01-01', 6, null, null), charge('2026-01-03', 2, '2026-01-03', 6, 40, 80)], null), []);
});

test('drive drops larger than the total clamp parked to 0', () => {
  const charges = [charge('2026-01-01', 1, '2026-01-01', 6, 40, 70), charge('2026-01-02', 2, '2026-01-02', 6, 60, 80)];
  const rows = computeDailyUse([drive('2026-01-01', 12, 70, 55)], charges, null);
  assert.ok(rows.every((r) => r.parked_pct === 0));
  assert.equal(rows[0].used_pct, 15);
});

test('localDate uses the process time zone', () => {
  assert.equal(localDate(Date.parse('2026-01-10T07:59:00Z')), '2026-01-09');   // 23:59 PST
  assert.equal(localDate(Date.parse('2026-01-10T08:01:00Z')), '2026-01-10');
});
