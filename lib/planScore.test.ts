// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/planScore.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driftDecision, isoWeek, medianOf, scoreDay, summarize, type ScoreEntry } from './planScore.ts';

const day = (iso: string) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86_400_000);
const planned = { pct: 20, kwh: 15, aimKw: 8, houseKw: 3, roomKw: 4 };
const base = { day: 100, date: '2026-04-11', floorPct: 25, peak: null, lowSocPct: 40 };

test('scoreDay: use error is (actual - planned) / planned in percent; kWh by the plan\'s own kWh per %', () => {
  const e = scoreDay({ ...base, planned, actualPct: 25 });
  assert.equal(e.useErrPct, 25);
  assert.equal(e.actualKwh, 18.75);
  assert.equal(e.short, false);
  assert.equal(scoreDay({ ...base, planned, actualPct: 15 }).useErrPct, -25);
});

test('scoreDay: unknown pieces stay null; short is lowest SoC under the floor', () => {
  const e = scoreDay({ ...base, planned: null, actualPct: null, lowSocPct: null });
  assert.deepEqual([e.useErrPct, e.short, e.peakScored, e.plannedPct], [null, null, false, null]);
  assert.equal(scoreDay({ ...base, planned, actualPct: 20, lowSocPct: 24.9 }).short, true);
  assert.equal(scoreDay({ ...base, planned, actualPct: 20, lowSocPct: 25 }).short, false);
  assert.equal(scoreDay({ ...base, planned: { ...planned, pct: 0 }, actualPct: 20 }).useErrPct, null);
});

test('scoreDay: peak error against the forecast day peak (aim / 0.8), actual room', () => {
  const e = scoreDay({ ...base, planned, actualPct: 20, peak: { dayKw: 11, houseNightKw: 2 } });
  assert.equal(e.fcPeakKw, 10);
  assert.equal(e.peakErrPct, 10);
  assert.equal(e.roomKw, 6.8);
  assert.equal(e.peakScored, true);
  const none = scoreDay({ ...base, planned: { ...planned, aimKw: null }, actualPct: 20, peak: { dayKw: 11, houseNightKw: 2 } });
  assert.deepEqual([none.peakErrPct, none.peakScored], [null, true]);
  assert.equal(scoreDay({ ...base, planned, actualPct: 20, peak: { dayKw: 11, houseNightKw: null } }).peakScored, false);
});

test('medianOf and summarize: window, median use and peak error, short days', () => {
  assert.equal(medianOf([]), null);
  assert.equal(medianOf([3, 1, 2]), 2);
  assert.equal(medianOf([1, 2, 3, 10]), 2.5);
  const mk = (d: number, use: number | null, short: boolean | null, peak: number | null = null): ScoreEntry => ({
    ...scoreDay({ ...base, day: d, planned, actualPct: 20, lowSocPct: null }), useErrPct: use, short, peakErrPct: peak,
  });
  const es = [mk(1, 50, true), mk(10, 5, false), mk(11, 15, true, 4), mk(12, -5, false, 8), mk(13, null, null)];
  const s = summarize(es, 10, 13);
  assert.deepEqual([s.days, s.medianUseErrPct, s.shortDays, s.medianPeakErrPct, s.peakDays], [3, 5, 1, 6, 2]);
});

test('isoWeek: Monday-based, year boundary', () => {
  assert.equal(isoWeek(day('2026-11-09')), '2026-W46');
  assert.equal(isoWeek(day('2026-11-15')), '2026-W46');
  assert.equal(isoWeek(day('2026-11-16')), '2026-W47');
  assert.equal(isoWeek(day('2026-01-01')), '2026-W01');
  assert.equal(isoWeek(day('2027-01-01')), '2026-W53');
});

test('driftDecision: median use error above +10% or a short day in 7; once per ISO week', () => {
  const today = day('2026-11-13');
  const mk = (d: number, use: number | null, short = false): ScoreEntry => ({
    ...scoreDay({ ...base, day: d, planned, actualPct: 20 }), useErrPct: use, short,
  });
  const high = [1, 2, 3, 4].map((k) => mk(today - k, 12));
  const d = driftDecision(high, today, null);
  assert.equal(d.fire, true);
  assert.equal(d.week, '2026-W46');
  assert.match(d.message, /12% above/);
  assert.equal(driftDecision(high, today, '2026-W46').fire, false);          // already sent this week
  assert.equal(driftDecision(high, today, '2026-W45').fire, true);
  assert.equal(driftDecision([1, 2, 3, 4].map((k) => mk(today - k, 10)), today, null).fire, false);   // exactly +10 is not over
  assert.equal(driftDecision([mk(today - 1, 40), mk(today - 2, 40)], today, null).fire, false);        // too few days
  const short = driftDecision([mk(today - 3, 0, true)], today, null);
  assert.equal(short.fire, true);
  assert.match(short.message, /1 of the last 7 days/);
  assert.equal(driftDecision([mk(today - 9, 0, true)], today, null).fire, false);                       // short day older than 7
  assert.equal(driftDecision([], today, null).fire, false);
});
