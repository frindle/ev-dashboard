// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/caldavWriteback.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { applyPlace, foldLine, writeBackPlace } from './caldavWriteback.ts';
import { parseIcsEvents } from './ics.ts';

const ICS = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:e1', 'SUMMARY:Thing', 'DTSTART:20261117T200000Z', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:e2', 'SUMMARY:Other', 'LOCATION:Keep me', 'GEO:1;2', 'DTSTART:20261118T200000Z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
const PLACE = { lat: 36.1, lon: -115.2, label: 'Cafe, Main St' };

test('applyPlace: adds LOCATION when absent, GEO and structured location; other events untouched; unknown uid -> null', () => {
  const out = applyPlace(ICS, 'e1', PLACE)!;
  const [e1, e2] = parseIcsEvents(out);
  assert.equal(e1.location, 'Cafe, Main St');
  assert.deepEqual(e1.geo, { lat: 36.1, lon: -115.2 });
  assert.deepEqual(e1.structuredGeo, { lat: 36.1, lon: -115.2 });
  assert.equal(e2.location, 'Keep me');
  assert.deepEqual(e2.geo, { lat: 1, lon: 2 });
  const keep = parseIcsEvents(applyPlace(ICS, 'e2', PLACE)!)[1];
  assert.equal(keep.location, 'Keep me');               // an existing LOCATION is not replaced
  assert.deepEqual(keep.geo, { lat: 36.1, lon: -115.2 });
  assert.equal(applyPlace(ICS, 'nope', PLACE), null);
});

test('foldLine folds at 75 octets and unfolds back', () => {
  const l = 'X:' + 'é'.repeat(80);
  const f = foldLine(l);
  assert.ok(f.split('\r\n').every((p) => new TextEncoder().encode(p).length <= 75));
  assert.equal(f.replace(/\r\n /g, ''), l);
});

async function fake(putStatus: number, etag = '"abc"') {
  const seen: { method: string; url: string; ifMatch?: string; body: string }[] = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, ifMatch: req.headers['if-match'] as string | undefined, body });
      if (req.method === 'REPORT') {
        const data = ICS.replace(/&/g, '&amp;').replace(/</g, '&lt;');
        res.writeHead(207, { 'Content-Type': 'application/xml' });
        res.end(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/cal/e1.ics</d:href><d:propstat><d:prop>${etag ? `<d:getetag>${etag.replace(/"/g, '&quot;')}</d:getetag>` : ''}<c:calendar-data>${data}</c:calendar-data></d:prop></d:propstat></d:response></d:multistatus>`);
      } else { res.writeHead(putStatus); res.end(); }
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/cal/?export`;
  return { seen, base, close: () => srv.close() };
}

test('write-back: off without the flag (no request); REPORT then PUT with If-Match', async () => {
  const s = await fake(204);
  try {
    const url = { PERSONAL_CAL_URL: s.base, PERSONAL_CAL_USER: 'u', PERSONAL_CAL_PASSWORD: 'p' };
    assert.equal(await writeBackPlace('e1', PLACE, url), 'off');
    assert.equal(s.seen.length, 0);
    assert.equal(await writeBackPlace('e1', PLACE, { ...url, PERSONAL_CAL_WRITEBACK: '1' }), 'written');
    assert.deepEqual(s.seen.map((r) => r.method), ['REPORT', 'PUT']);
    assert.equal(s.seen[1].url, '/cal/e1.ics');
    assert.equal(s.seen[1].ifMatch, '"abc"');
    assert.match(s.seen[1].body, /GEO:36\.100000;-115\.200000/);
  } finally { s.close(); }
});

test('write-back: 412 is a conflict; unknown uid not-found; no etag -> error and no PUT', async () => {
  const env = (base: string) => ({ PERSONAL_CAL_URL: base, PERSONAL_CAL_WRITEBACK: '1' });
  const c = await fake(412);
  try { assert.equal(await writeBackPlace('e1', PLACE, env(c.base)), 'conflict'); } finally { c.close(); }
  const n = await fake(204);
  try { assert.equal(await writeBackPlace('zzz', PLACE, env(n.base)), 'not-found'); assert.deepEqual(n.seen.map((r) => r.method), ['REPORT']); } finally { n.close(); }
  const e = await fake(204, '');
  try { assert.equal(await writeBackPlace('e1', PLACE, env(e.base)), 'error'); assert.deepEqual(e.seen.map((r) => r.method), ['REPORT']); } finally { e.close(); }
});
