// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/ics.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcsEvents, parseIcsTime, propValue, unfoldIcs } from './ics.ts';

const ev = (...lines: string[]) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
const cal = (...events: string[]) => ['BEGIN:VCALENDAR', ...events, 'END:VCALENDAR'].join('\r\n');

test('parseIcsTime: UTC, TZID (quoted too), floating, all-day', () => {
  assert.deepEqual(parseIcsTime('DTSTART:20261110T200000Z'), { ms: Date.parse('2026-11-10T20:00:00Z'), allDay: false });
  assert.equal(parseIcsTime('DTSTART;TZID=America/Chicago:20261110T120000')!.ms, Date.parse('2026-11-10T12:00:00-06:00'));
  assert.equal(parseIcsTime('DTEND;TZID="America/New_York":20261110T120000')!.ms, Date.parse('2026-11-10T12:00:00-05:00'));
  assert.equal(parseIcsTime('DTSTART:20261110T120000')!.ms, Date.parse('2026-11-10T12:00:00-08:00'));
  assert.deepEqual(parseIcsTime('DTSTART;VALUE=DATE:20261115'), { ms: new Date(2026, 10, 15).getTime(), allDay: true });
  assert.equal(parseIcsTime('DTSTART:garbage'), null);
});

test('parseIcsEvents: folded lines, escapes, structured location, GEO, description, alarms ignored', () => {
  const ics = cal(
    ev('UID:a', 'SUMMARY:Lun', ' ch', 'DTSTART;TZID=America/Los_Angeles:20261117T120000', 'DTEND;TZID=America/Los_Angeles:20261117T130000',
      'LOCATION:Cafe\\, 12 Main St\\nSuite 4', 'GEO:36.1;-115.2', 'DESCRIPTION:bring it #home',
      'X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-ADDRESS="1 A St: Town";X-TITLE=Cafe:geo:36.171234,-115.139876',
      'BEGIN:VALARM', 'TRIGGER:-PT1H', 'DESCRIPTION:alarm', 'END:VALARM'),
    ev('UID:b', 'SUMMARY:Trip', 'DTSTART;VALUE=DATE:20261120', 'DTEND;VALUE=DATE:20261123', 'STATUS:CANCELLED'),
  );
  const [a, b] = parseIcsEvents(ics);
  assert.equal(a.uid, 'a');
  assert.equal(a.summary, 'Lunch');
  assert.equal(a.location, 'Cafe, 12 Main St\nSuite 4');
  assert.deepEqual(a.geo, { lat: 36.1, lon: -115.2 });
  assert.deepEqual(a.structuredGeo, { lat: 36.171234, lon: -115.139876 });
  assert.equal(a.description, 'bring it #home');
  assert.equal(a.start!.ms, Date.parse('2026-11-17T12:00:00-08:00'));
  assert.equal(b.start!.allDay, true);
  assert.equal(b.cancelled, true);
  assert.equal(parseIcsEvents('').length, 0);
});

test('helpers: unfold and propValue skip colons inside quotes', () => {
  assert.deepEqual(unfoldIcs('A:1\r\n 2\r\nB:3'), ['A:12', 'B:3']);
  assert.equal(propValue('X;P="a:b":geo:1,2'), 'geo:1,2');
});
