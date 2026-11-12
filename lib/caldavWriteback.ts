// Write a place picked on /trips back to its calendar event over CalDAV
// (EV charge plan #8): LOCATION (only when the event has none), GEO and
// X-APPLE-STRUCTURED-LOCATION, with an If-Match ETag check so a newer edit is
// never overwritten. Behind PERSONAL_CAL_WRITEBACK=1; until then picks stay in
// keys/geo-overrides.json. Tested against a fake server only.
//
// The calendar collection is PERSONAL_CAL_URL without its query (the Nextcloud
// `?export`). The event is found by UID with a calendar-query REPORT, so its
// file name does not matter.
import type { LatLon } from './ics.ts';

export type WritebackResult = 'written' | 'off' | 'not-found' | 'conflict' | 'error';

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const esc = (s: string) => s.replace(/[\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n');
const quote = (s: string) => s.replace(/["\r\n]/g, ' ');

// Fold a content line at 75 octets (RFC 5545).
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let cur = '';
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (curBytes + b > limit) { parts.push(cur); cur = ''; curBytes = 0; limit = 74; }
    cur += ch; curBytes += b;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

// The ICS text with the event `uid` carrying the picked place. null when the uid is not in it.
export function applyPlace(ics: string, uid: string, p: LatLon & { label: string }): string | null {
  const lines = ics.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inEvent = false, depth = 0, hit = false, done = false;
  let block: string[] = [];
  const flush = () => {
    // block = the unfolded-by-continuation property groups of one VEVENT
    const joined: string[] = [];
    for (const l of block) { if (/^[ \t]/.test(l) && joined.length) joined[joined.length - 1] += '\n' + l; else joined.push(l); }
    const isUid = joined.some((g) => g.replace(/\n[ \t]/g, '') === `UID:${uid}`);
    if (!isUid) { out.push(...block); return; }
    hit = true;
    const hasLoc = joined.some((g) => /^LOCATION[;:]/.test(g) && g.replace(/\n[ \t]/g, '').split(':').slice(1).join(':').trim() !== '');
    const kept = joined.filter((g) => !/^(GEO|X-APPLE-STRUCTURED-LOCATION)[;:]/.test(g) && !(!hasLoc && /^LOCATION[;:]/.test(g)));
    const add = [
      ...(hasLoc ? [] : [`LOCATION:${esc(p.label)}`]),
      `GEO:${p.lat.toFixed(6)};${p.lon.toFixed(6)}`,
      `X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-ADDRESS="${quote(p.label)}";X-APPLE-RADIUS=72;X-TITLE="${quote(p.label)}":geo:${p.lat.toFixed(6)},${p.lon.toFixed(6)}`,
    ].map(foldLine);
    // keep the original lines (with their folds) for what stays
    for (const g of kept) out.push(...g.split('\n'));
    out.push(...add.flatMap((a) => a.split('\r\n')));
  };
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT' && !done) { inEvent = true; depth = 1; block = []; out.push(line); continue; }
    if (!inEvent) { out.push(line); continue; }
    if (line.startsWith('BEGIN:')) depth++;
    if (line.startsWith('END:')) {
      if (--depth === 0) { flush(); inEvent = false; out.push(line); if (hit) done = true; continue; }
    }
    block.push(line);
  }
  return hit ? out.join('\r\n') : null;
}

const unxml = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#13;/g, '\r').replace(/&amp;/g, '&');

export async function writeBackPlace(
  uid: string, p: LatLon & { label: string },
  env: Record<string, string | undefined> = process.env, fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<WritebackResult> {
  if (env.PERSONAL_CAL_WRITEBACK !== '1' || !env.PERSONAL_CAL_URL || !uid) return 'off';
  try {
    const coll = new URL(env.PERSONAL_CAL_URL.replace(/^webcal:\/\//i, 'https://'));
    coll.search = ''; coll.hash = '';
    if (!coll.pathname.endsWith('/')) coll.pathname += '/';
    const auth: Record<string, string> = env.PERSONAL_CAL_USER
      ? { Authorization: 'Basic ' + Buffer.from(`${env.PERSONAL_CAL_USER}:${env.PERSONAL_CAL_PASSWORD ?? ''}`).toString('base64') } : {};
    const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:prop-filter name="UID"><c:text-match collation="i;octet">${uid.replace(/[<>&]/g, '')}</c:text-match></c:prop-filter></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
    const rep = await fetchImpl(coll.toString(), {
      method: 'REPORT', headers: { ...auth, 'Content-Type': 'application/xml; charset=utf-8', Depth: '1' }, body, signal: AbortSignal.timeout(15_000),
    });
    if (!rep.ok) return 'error';
    const xml = await rep.text();
    const href = /<(?:\w+:)?href>([^<]+)<\/(?:\w+:)?href>/.exec(xml)?.[1];
    const etag = /<(?:\w+:)?getetag>([\s\S]*?)<\/(?:\w+:)?getetag>/.exec(xml)?.[1];
    const data = /<(?:\w+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:\w+:)?calendar-data>/.exec(xml)?.[1];
    if (!href || !data) return 'not-found';
    if (!etag) return 'error';   // never write without an ETag to check
    const next = applyPlace(unxml(data), uid, p);
    if (!next) return 'not-found';
    const put = await fetchImpl(new URL(unxml(href), coll).toString(), {
      method: 'PUT', headers: { ...auth, 'Content-Type': 'text/calendar; charset=utf-8', 'If-Match': unxml(etag).trim() },
      body: next, signal: AbortSignal.timeout(15_000),
    });
    if (put.status === 412) return 'conflict';
    return put.ok ? 'written' : 'error';
  } catch (e) {
    console.error('[trips] write-back failed:', (e instanceof Error ? e.name : 'error'));
    return 'error';
  }
}
