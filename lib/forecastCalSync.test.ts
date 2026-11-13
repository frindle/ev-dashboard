// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/forecastCalSync.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverCollection, forecastCalConfig, syncForecastCalendar, type FetchLike, type SyncDeps } from './forecastCalSync.ts';
import { summaryFor, signature, uidFor, type ForecastDayIn, type ManualNeed, type SyncState } from './forecastCalEvents.ts';

const COLL = 'https://nc.example.com/remote.php/dav/calendars/penn/ev-charge-forecast/';
const ENV = { FORECAST_CAL_NAME: 'EV Charge Forecast', PERSONAL_CAL_URL: 'https://nc.example.com/remote.php/dav/calendars/penn/personal?export', PERSONAL_CAL_USER: 'ev', PERSONAL_CAL_PASSWORD: 'pw' };
const res = (status: number, body = '', etag: string | null = null) => ({ ok: status >= 200 && status < 300, status, text: async () => body, headers: { get: (n: string) => (n.toLowerCase() === 'etag' ? etag : null) } });

const home = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/remote.php/dav/calendars/penn/ev-charge-forecast/</d:href><d:propstat><d:prop><d:displayname>EV Charge Forecast (Penn)</d:displayname><d:resourcetype><d:collection/><c:calendar xmlns:c="urn:ietf:params:xml:ns:caldav"/></d:resourcetype></d:prop></d:propstat></d:response>
<d:response><d:href>/remote.php/dav/calendars/penn/personal/</d:href><d:propstat><d:prop><d:displayname>Personal</d:displayname><d:resourcetype><d:collection/><c:calendar xmlns:c="urn:ietf:params:xml:ns:caldav"/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>`;
const report = (items: { date: string; summary: string; etag?: string }[]) => `<d:multistatus xmlns:d="DAV:">${items.map((i) =>
  `<d:response><d:href>/remote.php/dav/calendars/penn/ev-charge-forecast/${i.date}.ics</d:href><d:propstat><d:prop><d:getetag>${i.etag ?? '&quot;e1&quot;'}</d:getetag><cal:calendar-data xmlns:cal="urn:ietf:params:xml:ns:caldav">BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:${uidFor(i.date)}\r\nSUMMARY:${i.summary}\r\nEND:VEVENT\r\nEND:VCALENDAR</cal:calendar-data></d:prop></d:propstat></d:response>`).join('')}</d:multistatus>`;

const D = '2026-11-13';
const want = (over: Partial<ForecastDayIn> = {}): ForecastDayIn => ({ date: D, day: 20000, miles: 34, pct: 14, source: 'work model', highF: 55, typed: null, typedBelow: false, away: false, night: null, ...over });

function harness(opts: { remote: { date: string; summary: string }[] | null; state?: SyncState; putStatus?: number; env?: Record<string, string> }) {
  const calls: { method: string; url: string; headers: Record<string, string>; body?: string }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ method: init.method, url, headers: init.headers, body: init.body });
    if (init.method === 'PROPFIND') return res(207, home);
    if (init.method === 'REPORT') return opts.remote ? res(207, report(opts.remote)) : res(500);
    return res(opts.putStatus ?? 201, '', '"new"');
  };
  const needs: [number, ManualNeed | null][] = [];
  let planned = 0, saved: SyncState | null = null;
  let current = want();
  const deps: SyncDeps = {
    env: opts.env ?? ENV, fetchImpl, nowMs: Date.parse('2026-11-12T20:00:00Z'),
    buildWant: async () => [current],
    setNeed: async (d, n) => { needs.push([d, n]); if (n) current = want({ typed: n }); else current = want(); },
    forcePlan: async () => { planned++; },
    readState: async () => structuredClone(opts.state ?? { days: {} }),
    writeState: async (s) => { saved = s; },
  };
  return { calls, deps, needs, planned: () => planned, saved: () => saved };
}
const synced = (): SyncState => ({ collection: COLL, days: { [D]: { summary: summaryFor(want()), etag: '"e1"', sig: signature(want(), null) } } });

test('config: off without name or url; URL wins; auth falls back to the personal calendar login', () => {
  assert.equal(forecastCalConfig({}), null);
  const c = forecastCalConfig(ENV)!;
  assert.equal(c.collection, null);
  assert.match(c.auth.Authorization, /^Basic /);
  const u = forecastCalConfig({ ...ENV, FORECAST_CAL_URL: 'webcal://nc.example.com/remote.php/dav/calendars/penn/x?export' })!;
  assert.equal(u.collection, 'https://nc.example.com/remote.php/dav/calendars/penn/x/');
});

test('discovery finds the calendar by display name', async () => {
  const h = harness({ remote: [] });
  assert.equal(await discoverCollection(forecastCalConfig(ENV)!, h.deps.fetchImpl), COLL);
  assert.equal(await discoverCollection(forecastCalConfig({ ...ENV, FORECAST_CAL_NAME: 'Nope' })!, h.deps.fetchImpl), null);
});

test('first run creates the day with If-None-Match and saves state', async () => {
  const h = harness({ remote: [] });
  const r = await syncForecastCalendar(h.deps);
  assert.equal(r.status, 'ok'); assert.equal(r.created, 1);
  const put = h.calls.find((c) => c.method === 'PUT')!;
  assert.equal(put.headers['If-None-Match'], '*');
  assert.match(put.url, /ev-charge-forecast\//);
  assert.equal(h.saved()!.days[D].summary, 'EV 34 mi');
  assert.equal(h.saved()!.collection, COLL);
});

test('unchanged: no writes', async () => {
  const h = harness({ remote: [{ date: D, summary: 'EV 34 mi' }], state: synced() });
  const r = await syncForecastCalendar(h.deps);
  assert.equal(r.created + r.updated, 0);
  assert.ok(!h.calls.some((c) => c.method === 'PUT'));
});

test('an edited title sets the need, forces a plan, and rewrites with If-Match', async () => {
  const h = harness({ remote: [{ date: D, summary: 'EV 60 mi' }], state: synced() });
  const r = await syncForecastCalendar(h.deps);
  assert.equal(r.edits, 1); assert.equal(r.updated, 1);
  assert.deepEqual(h.needs, [[20000, { value: 60, unit: 'mi' }]]);
  assert.equal(h.planned(), 1);
  const put = h.calls.find((c) => c.method === 'PUT')!;
  assert.equal(put.headers['If-Match'], '"e1"');
  assert.match(put.body!, /SUMMARY:EV 60 mi \(set\)/);
});

test('EV 0 is not applied: need untouched, note written', async () => {
  const h = harness({ remote: [{ date: D, summary: 'EV 0' }], state: synced() });
  await syncForecastCalendar(h.deps);
  assert.deepEqual(h.needs, []);
  assert.equal(h.planned(), 0);
  assert.match(h.calls.find((c) => c.method === 'PUT')!.body!.replace(/\r\n /g, ''), /Couldn't read that title/);
});

test('a deleted event clears the need and is recreated', async () => {
  const h = harness({ remote: [], state: synced() });
  const r = await syncForecastCalendar(h.deps);
  assert.deepEqual(h.needs, [[20000, null]]);
  assert.equal(r.created, 1);
});

test('412 counts as a conflict, a failed read and a thrown error never throw', async () => {
  const c = harness({ remote: [], putStatus: 412 });
  const r = await syncForecastCalendar(c.deps);
  assert.equal(r.conflicts, 1); assert.equal(r.created, 0);
  const bad = harness({ remote: null, state: synced() });
  assert.equal((await syncForecastCalendar(bad.deps)).status, 'error');
  const boom = harness({ remote: [] });
  boom.deps.fetchImpl = async () => { throw new Error('net'); };
  assert.equal((await syncForecastCalendar(boom.deps)).status, 'error');
  assert.equal((await syncForecastCalendar({ ...boom.deps, env: {} })).status, 'off');
});
