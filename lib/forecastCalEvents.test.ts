// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/forecastCalEvents.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIcs, dateOfUid, decideWrites, findEdits, parseTitle, signature, summaryFor, uidFor, UNREADABLE_NOTE,
  type ForecastDayIn, type RemoteEvent, type SyncState,
} from './forecastCalEvents.ts';

const day = (date: string, over: Partial<ForecastDayIn> = {}): ForecastDayIn => ({
  date, day: 20000, miles: 34, pct: 14, source: 'work model', highF: 55, typed: null, typedBelow: false, away: false,
  night: { plug: true, amps: 16, windowHours: 7.5, morningPct: 80, arrivalPct: 66 }, ...over,
});

test('parseTitle: numbers, units, auto, and 0 / junk unreadable', () => {
  assert.deepEqual(parseTitle('EV 60 mi'), { kind: 'need', need: { value: 60, unit: 'mi' } });
  assert.deepEqual(parseTitle('EV 25%'), { kind: 'need', need: { value: 25, unit: 'pct' } });
  assert.deepEqual(parseTitle('ev 25 percent'), { kind: 'need', need: { value: 25, unit: 'pct' } });
  assert.deepEqual(parseTitle('70'), { kind: 'need', need: { value: 70, unit: 'mi' } });
  assert.deepEqual(parseTitle('EV auto'), { kind: 'auto' });
  assert.deepEqual(parseTitle('Forecast'), { kind: 'auto' });
  assert.deepEqual(parseTitle('EV 50 mi (set 20, below forecast)'), { kind: 'need', need: { value: 50, unit: 'mi' } });
  assert.deepEqual(parseTitle('EV 0'), { kind: 'unreadable' });
  assert.deepEqual(parseTitle('EV 0%'), { kind: 'unreadable' });
  assert.deepEqual(parseTitle('EV lots'), { kind: 'unreadable' });
  assert.deepEqual(parseTitle('EV 99999 mi'), { kind: 'unreadable' });
});

test('summaryFor: forecast, set above, set below, away', () => {
  assert.equal(summaryFor(day('2026-11-13')), 'EV 34 mi');
  assert.equal(summaryFor(day('2026-11-13', { typed: { value: 60, unit: 'mi' } })), 'EV 60 mi (set)');
  assert.equal(summaryFor(day('2026-11-13', { typed: { value: 25, unit: 'pct' } })), 'EV 25% (set)');
  assert.equal(summaryFor(day('2026-11-13', { typed: { value: 20, unit: 'mi' }, typedBelow: true })), 'EV 34 mi (set 20, below forecast)');
  assert.equal(summaryFor(day('2026-11-13', { away: true, miles: null })), 'EV away');
});

test('uid round trip', () => {
  assert.equal(dateOfUid(uidFor('2026-11-13')), '2026-11-13');
  assert.equal(dateOfUid('other@x'), null);
});

test('buildIcs: all-day, transparent, folded, only numbers', () => {
  const ics = buildIcs(day('2026-12-31'), Date.parse('2026-11-12T20:00:00Z'));
  assert.match(ics, /UID:ev-need-2026-12-31@home-dashboards\r\n/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261231\r\n/);
  assert.match(ics, /DTEND;VALUE=DATE:20270101\r\n/);
  assert.match(ics, /TRANSP:TRANSPARENT/);
  assert.match(ics, /SUMMARY:EV 34 mi\r\n/);
  assert.match(ics.replace(/\r\n /g, ''), /only raises the plan: a number below the forecast is ignored/);
  for (const l of ics.split('\r\n')) assert.ok(Buffer.byteLength(l) <= 75);
});

const remote = (date: string, summary: string): [string, RemoteEvent] => [date, { href: `/c/${date}.ics`, etag: '"e1"', summary }];
const stateOf = (d: ForecastDayIn): SyncState => ({ days: { [d.date]: { summary: summaryFor(d), etag: '"e1"', sig: signature(d, null) } } });

test('findEdits: edited title, deleted event, unreadable, unchanged, not listed', () => {
  const d = day('2026-11-13');
  const state = stateOf(d);
  const f = (r: Map<string, RemoteEvent>, listed = true) => findEdits({ want: [d], remote: r, state, listed });
  assert.deepEqual(f(new Map([remote(d.date, 'EV 34 mi')])), []);
  assert.deepEqual(f(new Map([remote(d.date, 'EV 60 mi')])), [{ date: d.date, day: d.day, need: { value: 60, unit: 'mi' }, unreadable: false }]);
  assert.deepEqual(f(new Map([remote(d.date, 'auto')])), [{ date: d.date, day: d.day, need: null, unreadable: false }]);
  assert.deepEqual(f(new Map()), [{ date: d.date, day: d.day, need: null, unreadable: false }]);
  assert.deepEqual(f(new Map([remote(d.date, 'EV 0')])), [{ date: d.date, day: d.day, need: null, unreadable: true }]);
  assert.deepEqual(f(new Map(), false), []);
  assert.deepEqual(findEdits({ want: [d], remote: new Map(), state: { days: {} }, listed: true }), []);
});

test('decideWrites: create, unchanged, forecast moved, edit normalizes, unreadable note', () => {
  const d = day('2026-11-13');
  const state = stateOf(d);
  const r = new Map([remote(d.date, 'EV 34 mi')]);
  assert.deepEqual(decideWrites({ want: [d], remote: r, state, edits: [], listed: true }), []);
  assert.equal(decideWrites({ want: [d], remote: new Map(), state, edits: [], listed: true })[0].kind, 'create');
  const moved = day(d.date, { miles: 40 });
  assert.equal(decideWrites({ want: [moved], remote: r, state, edits: [], listed: true })[0].kind, 'update');
  const edit = { date: d.date, day: d.day, need: { value: 60, unit: 'mi' as const }, unreadable: false };
  const typed = day(d.date, { typed: edit.need });
  assert.equal(decideWrites({ want: [typed], remote: new Map([remote(d.date, 'EV 60 mi')]), state, edits: [edit], listed: true })[0].kind, 'update');
  const bad = { date: d.date, day: d.day, need: null, unreadable: true };
  const w = decideWrites({ want: [d], remote: new Map([remote(d.date, 'EV 0')]), state, edits: [bad], listed: true })[0];
  assert.equal(w.kind === 'update' && w.note, UNREADABLE_NOTE);
  assert.deepEqual(decideWrites({ want: [d], remote: r, state, edits: [], listed: false }), []);
});
