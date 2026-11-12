// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/planCalendar.test.ts
// Calendar parsing (open shifts, time off, DTEND, refresh) and the Influx shift-day points. Mocked fetch only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShiftCalendarSource, parseShiftCalendar } from './shiftCalendar.ts';
import { shiftDayLines } from './planInflux.ts';

const day = (iso: string) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86_400_000);
const ev = (...lines: string[]) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
const cal = (...events: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events, 'END:VCALENDAR'].join('\r\n');
const days = (s: Set<number>) => [...s].sort((a, b) => a - b);

test('parseShiftCalendar: times, open shifts skipped, time off wins, multi-day, DTEND', () => {
  const ics = cal(
    ev('UID:w1', 'SUMMARY:D3P', 'DTSTART:20261110T200000Z', 'DTEND:20261111T060000Z'),                 // 12:00-22:00 PST Nov 10
    ev('UID:o1', 'SUMMARY:D3P', 'CATEGORIES:Open Shift', 'DTSTART:20261111T200000Z', 'DTEND:20261112T060000Z'),
    ev('UID:w2', 'SUMMARY:D1P', 'DTSTART:20261112T200000Z', 'DTEND:20261113T060000Z'),                 // Nov 12, taken by PTO
    ev('UID:p1', 'SUMMARY:PTO', 'DTSTART;VALUE=DATE:20261112', 'DTEND;VALUE=DATE:20261115'),            // Nov 12-14 (DTEND exclusive)
    ev('UID:w3', 'SUMMARY:D2A', 'DTSTART:20261116T140000Z', 'DTEND:20261116T230000Z'),                 // Nov 16
    ev('UID:w4', 'SUMMARY:D4P', 'DTSTART:20261117T200000Z'),                                            // no DTEND -> 10h
  );
  const r = parseShiftCalendar(ics);
  assert.equal(process.env.TZ, 'America/Los_Angeles');
  assert.deepEqual(days(r.workDays), ['2026-11-10', '2026-11-16', '2026-11-17'].map(day));
  assert.deepEqual(days(r.timeOffDays), ['2026-11-12', '2026-11-13', '2026-11-14'].map(day));
  const w1 = r.shifts.find((s) => s.uid === 'w1')!;
  assert.equal(w1.startMs, Date.parse('2026-11-10T12:00:00-08:00'));
  assert.equal(w1.endMs, Date.parse('2026-11-10T22:00:00-08:00'));
  const w4 = r.shifts.find((s) => s.uid === 'w4')!;
  assert.equal(w4.endMs - w4.startMs, 10 * 3_600_000);
  assert.ok(!r.shifts.some((s) => s.uid === 'o1' || s.uid === 'w2'));
});

test('createShiftCalendarSource: refresh bypasses the cache and the retry wait', async () => {
  const calls: string[] = [];
  const impl = async (url: string) => { calls.push(url); return { ok: true, status: 200, text: async () => cal(ev('UID:a', 'SUMMARY:D3P', 'DTSTART:20261110T200000Z', 'DTEND:20261111T060000Z')) }; };
  const get = createShiftCalendarSource();
  const env = { SHIFTS_ICS_URL: 'webcal://example.invalid/token' };
  const t = Date.parse('2026-11-12T08:00:00-08:00');
  await get(t, env, impl as never);
  await get(t + 60_000, env, impl as never);
  assert.equal(calls.length, 1);
  await get(t + 120_000, env, impl as never, { refresh: true });
  assert.equal(calls.length, 2);
});

test('shiftDayLines: depart_min / home_min on work days, work=0 on time-off days', () => {
  const d = day('2026-11-12');
  const mid = new Date(2026, 10, 12).getTime();
  const shifts = [{ day: d, startMs: mid + 14.5 * 3_600_000, endMs: mid + 24.5 * 3_600_000 }];
  const lines = shiftDayLines(new Set([d]), d, { shifts, timeOffDays: new Set([d + 1]) });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /work=1,depart_min=810,home_min=1490 /);
  assert.match(lines[1], /work=0 /);
  assert.ok(!lines[1].includes('depart_min'));
});
