// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/personalCalendar.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPersonalCalendarSource, eventsWithin, parsePersonalEvents, tagFromNotes } from './personalCalendar.ts';

const day = (iso: string) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86_400_000);
const ev = (...lines: string[]) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
const cal = (...events: string[]) => ['BEGIN:VCALENDAR', ...events, 'END:VCALENDAR'].join('\r\n');
const ICS = cal(
  ev('UID:1', 'SUMMARY:x', 'DTSTART:20261117T200000Z', 'DTEND:20261117T210000Z', 'LOCATION:Somewhere', 'DESCRIPTION:#straight'),
  ev('UID:2', 'SUMMARY:no place', 'DTSTART:20261117T200000Z', 'DTEND:20261117T210000Z'),
  ev('UID:3', 'SUMMARY:trip', 'DTSTART;VALUE=DATE:20261119', 'DTEND;VALUE=DATE:20261122', 'LOCATION:Far away'),
  ev('UID:4', 'SUMMARY:allday one', 'DTSTART;VALUE=DATE:20261118', 'DTEND;VALUE=DATE:20261119', 'GEO:36.1;-115.2'),
  ev('UID:5', 'SUMMARY:later', 'DTSTART:20261201T200000Z', 'LOCATION:Too far ahead'),
  ev('UID:6', 'SUMMARY:gone', 'DTSTART:20261118T200000Z', 'LOCATION:Cancelled', 'STATUS:CANCELLED'),
  ev('UID:7', 'SUMMARY:long', 'DTSTART:20261118T170000Z', 'DTEND:20261120T170000Z', 'LOCATION:Two nights'),
);

test('only events with a location; all-day and multi-day flags; tags', () => {
  const all = parsePersonalEvents(ICS);
  assert.deepEqual(all.map((e) => e.uid), ['1', '3', '4', '5', '7']);
  const by = Object.fromEntries(all.map((e) => [e.uid, e]));
  assert.equal(by['1'].tag, 'straight');
  assert.equal(by['3'].allDay && by['3'].multiDay, true);
  assert.equal(by['4'].allDay && !by['4'].multiDay, true);
  assert.equal(by['7'].multiDay, true);
  assert.equal(by['1'].multiDay, false);
  assert.equal(by['1'].day, day('2026-11-17'));
  assert.equal(tagFromNotes('go #HOME after'), 'home');
  assert.equal(tagFromNotes('c#home'), null);
  const now = Date.parse('2026-11-16T09:00:00-08:00');
  assert.deepEqual(eventsWithin(all, now).map((e) => e.uid), ['1', '4', '7', '3']);
});

test('flag off: nothing is fetched', async () => {
  const get = createPersonalCalendarSource();
  let calls = 0;
  const f = async () => { calls++; return { ok: true, status: 200, text: async () => ICS }; };
  assert.equal(await get(0, {}, f), null);
  assert.equal(await get(0, { PERSONAL_CAL_URL: '' }, f), null);
  assert.equal(calls, 0);
});

test('flag on: webcal as https, basic auth, cached, a failure keeps the last copy and hides the URL', async () => {
  const get = createPersonalCalendarSource();
  const seen: { url: string; headers: Record<string, string> }[] = [];
  let fail = false;
  const f = async (url: string, init: { headers: Record<string, string> }) => {
    seen.push({ url, headers: init.headers });
    if (fail) throw new Error(`boom ${url}`);
    return { ok: true, status: 200, text: async () => ICS };
  };
  const env = { PERSONAL_CAL_URL: 'webcal://cal.invalid/s3cret?export', PERSONAL_CAL_USER: 'u', PERSONAL_CAL_PASSWORD: 'p' };
  assert.equal((await get(1_000, env, f))!.length, 5);
  assert.equal(seen[0].url, 'https://cal.invalid/s3cret?export');
  assert.equal(seen[0].headers.Authorization, 'Basic ' + Buffer.from('u:p').toString('base64'));
  await get(2_000, env, f);
  assert.equal(seen.length, 1);
  fail = true;
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.join(' ')); };
  try { assert.equal((await get(2 * 3_600_000 * 4, env, f))!.length, 5); } finally { console.error = orig; }
  assert.ok(logged.length === 1 && !logged[0].includes('s3cret') && !logged[0].includes('cal.invalid'));
});
