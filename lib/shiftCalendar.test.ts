// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/shiftCalendar.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkDaysSource, workDaysFromIcs, zonedMs } from './shiftCalendar.ts';

const day = (iso: string) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86_400_000);
const ev = (...lines: string[]) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
const cal = (...events: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events, 'END:VCALENDAR'].join('\r\n');

test('zonedMs: wall time in a named zone, across DST, unknown zone -> local', () => {
  assert.equal(process.env.TZ, 'America/Los_Angeles');
  assert.equal(zonedMs(2026, 6, 1, 12, 0, 0, 'America/Chicago'), Date.parse('2026-07-01T12:00:00-05:00'));
  assert.equal(zonedMs(2026, 11, 1, 12, 0, 0, 'America/Chicago'), Date.parse('2026-12-01T12:00:00-06:00'));
  assert.equal(zonedMs(2026, 10, 1, 1, 30, 0, 'America/Los_Angeles'), Date.parse('2026-11-01T01:30:00-07:00'));
  assert.equal(zonedMs(2026, 10, 10, 9, 0, 0, 'Not/AZone'), Date.parse('2026-11-10T09:00:00-08:00'));
  assert.equal(zonedMs(2026, 10, 10, 9, 0, 0), Date.parse('2026-11-10T09:00:00-08:00'));
});

test('workDaysFromIcs: timed events of 4h+ on their local start date', () => {
  const ics = cal(
    ev('UID:a', 'DTSTART:20261110T200000Z', 'DTEND:20261111T060000Z', 'SUMMARY:x'),          // 12:00-22:00 PST Nov 10
    ev('UID:b', 'DTSTART:20261112T120000', 'DTEND:20261112T220000'),                          // floating = local
    ev('UID:c', 'DTSTART;TZID=America/Chicago:20261113T230000', 'DTEND;TZID=America/Chicago:20261114T090000'), // 21:00 PST Nov 13
    ev('UID:d', 'DTSTART;TZID="America/Los_Angeles":20261114T060000', 'DTEND;TZID="America/Los_Angeles":20261114T100000'), // exactly 4h
    ev('UID:e', 'DTSTART;VALUE=DATE:20261115', 'DTEND;VALUE=DATE:20261116'),                   // all-day: no
    ev('UID:f', 'DTSTART:20261116T180000Z', 'DTEND:20261116T205959Z'),                         // under 4h: no
    ev('UID:g', 'DTSTART:20261117T200000Z', 'DTEND:20261118T060000Z', 'STATUS:CANCELLED'),     // cancelled: no
    ev('UID:h', 'DTSTART:20261118T200000Z', 'DTEND:20261119T060000Z',
      'BEGIN:VALARM', 'TRIGGER:-PT1H', 'DTSTART:20261101T000000Z', 'END:VALARM', 'DESCRIPTION:long', '  folded'), // alarm DTSTART ignored
    ev('UID:i', 'DTSTART:2026111', ' 9T200000Z', 'DTEND:20261120T060000Z'),                   // folded DTSTART
    ev('UID:j', 'DTSTART:20261120T200000Z'),                                                   // no DTEND: no
  );
  assert.deepEqual([...workDaysFromIcs(ics)].sort((a, b) => a - b),
    ['2026-11-10', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-18', '2026-11-19'].map(day));
  assert.equal(workDaysFromIcs('').size, 0);
  assert.equal(workDaysFromIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:garbage\nEND:VEVENT\nEND:VCALENDAR').size, 0);
});

const ICS = cal(ev('DTSTART:20261110T200000Z', 'DTEND:20261111T060000Z'));
const SECRET = 'webcal://example.invalid/published/s3cr3t-token';

function fakeFetch(plan: Array<'ok' | 'fail' | 'throw'>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    const r = plan[calls.length - 1] ?? 'ok';
    if (r === 'throw') throw new Error(`fetch failed for ${url}`);
    return { ok: r === 'ok', status: r === 'ok' ? 200 : 500, text: async () => ICS };
  };
  return { calls, impl };
}

test('createWorkDaysSource: no URL -> null; webcal as https; cached 6h', async () => {
  const get = createWorkDaysSource();
  const f = fakeFetch(['ok', 'ok']);
  assert.equal(await get(0, {}, f.impl), null);
  assert.equal(f.calls.length, 0);
  const env = { SHIFTS_ICS_URL: SECRET };
  const days = await get(1_000, env, f.impl);
  assert.deepEqual([...days!], [day('2026-11-10')]);
  assert.equal(f.calls[0].url, 'https://example.invalid/published/s3cr3t-token');
  assert.deepEqual(f.calls[0].headers, {});
  await get(1_000 + 5 * 3_600_000, env, f.impl);
  assert.equal(f.calls.length, 1);
  await get(1_000 + 6 * 3_600_000, env, f.impl);
  assert.equal(f.calls.length, 2);
});

test('createWorkDaysSource: failure keeps the last good set, retries after 15 min, never logs the URL', async () => {
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
  try {
    const get = createWorkDaysSource();
    const env = { SHIFTS_ICS_URL: SECRET, SHIFTS_ICS_USER: 'penn', SHIFTS_ICS_PASSWORD: 'app-pass' };
    const f = fakeFetch(['throw', 'ok', 'fail']);
    assert.equal(await get(0, env, f.impl), null);                       // first try fails: nothing cached
    assert.equal(await get(60_000, env, f.impl), null);                  // within retry wait: no fetch
    assert.equal(f.calls.length, 1);
    assert.equal((await get(15 * 60_000, env, f.impl))!.size, 1);        // retry succeeds
    assert.equal(f.calls[1].headers.Authorization, 'Basic ' + Buffer.from('penn:app-pass').toString('base64'));
    const t = 15 * 60_000 + 6 * 3_600_000;
    assert.equal((await get(t, env, f.impl))!.size, 1);                  // refresh fails: keep the cached set
    assert.equal(f.calls.length, 3);
    assert.equal(logged.length, 2);
    for (const l of logged) assert.ok(!l.includes('s3cr3t') && !l.includes('example.invalid') && !l.includes('app-pass'), l);
  } finally {
    console.error = orig;
  }
});
