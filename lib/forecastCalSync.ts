// The "EV Charge Forecast" Nextcloud calendar, I/O: finds the calendar, reads its forecast events,
// turns Penn's edits into typed needs, and writes the events back (pure parts and the rules are in
// lib/forecastCalEvents.ts). Everything it touches comes in through `deps`, so the tests run it on a
// fake fetch. Off unless FORECAST_CAL_NAME or FORECAST_CAL_URL is set. Never throws; logs only
// error names, never an event title, place or coordinate.
import {
  buildIcs, dateOfUid, decideWrites, findEdits, signature, summaryFor, UID_PREFIX, uidFor,
  type ForecastDayIn, type ManualNeed, type RemoteEvent, type SyncState,
} from './forecastCalEvents.ts';

export interface FetchRes { ok: boolean; status: number; text(): Promise<string>; headers: { get(name: string): string | null } }
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<FetchRes>;

export interface SyncDeps {
  env: Record<string, string | undefined>;
  fetchImpl: FetchLike;
  nowMs: number;
  buildWant(): Promise<ForecastDayIn[]>;
  setNeed(day: number, need: ManualNeed | null): Promise<void>;
  forcePlan(): Promise<void>;
  readState(): Promise<SyncState>;
  writeState(s: SyncState): Promise<void>;
}

export interface SyncResult { status: 'off' | 'ok' | 'error'; created: number; updated: number; edits: number; conflicts: number; errors: number }

export interface CalConfig { collection: string | null; name: string | null; origin: string; user: string | null; auth: Record<string, string> }

export function forecastCalConfig(env: Record<string, string | undefined>): CalConfig | null {
  const url = env.FORECAST_CAL_URL?.trim() || null;
  const name = env.FORECAST_CAL_NAME?.trim() || null;
  if (!url && !name) return null;
  const base = url ?? env.PERSONAL_CAL_URL?.trim();
  if (!base) return null;
  let u: URL;
  try { u = new URL(base.replace(/^webcal:\/\//i, 'https://')); } catch { return null; }
  const user = env.FORECAST_CAL_USER?.trim() || env.PERSONAL_CAL_USER?.trim() || null;
  const password = env.FORECAST_CAL_PASSWORD || env.PERSONAL_CAL_PASSWORD || '';
  let collection: string | null = null;
  if (url) {
    const c = new URL(u); c.search = ''; c.hash = '';
    if (!c.pathname.endsWith('/')) c.pathname += '/';
    collection = c.toString();
  }
  return {
    collection, name, origin: u.origin, user,
    auth: user ? { Authorization: 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64') } : {},
  };
}

const unxml = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#13;/g, '\r').replace(/&amp;/g, '&');
const tag = (xml: string, name: string) => new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(xml)?.[1];
const responses = (xml: string) => xml.match(/<(?:\w+:)?response[\s>][\s\S]*?<\/(?:\w+:)?response>/g) ?? [];

// The calendar home lists Penn's shared calendar next to ev-dashboard's own.
export async function discoverCollection(cfg: CalConfig, fetchImpl: FetchLike): Promise<string | null> {
  if (!cfg.user || !cfg.name) return null;
  const home = `${cfg.origin}/remote.php/dav/calendars/${encodeURIComponent(cfg.user)}/`;
  const body = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>';
  const res = await fetchImpl(home, { method: 'PROPFIND', headers: { ...cfg.auth, Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' }, body, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const want = cfg.name.toLowerCase();
  for (const r of responses(await res.text())) {
    const href = tag(r, 'href');
    const shown = tag(r, 'displayname');
    const isCal = /<(?:\w+:)?calendar(?:\s[^>]*)?\/?>/.test(tag(r, 'resourcetype') ?? '');
    if (href && shown !== undefined && isCal && unxml(shown).trim().toLowerCase() === want) {
      const c = new URL(unxml(href), cfg.origin);
      if (!c.pathname.endsWith('/')) c.pathname += '/';
      return c.toString();
    }
  }
  return null;
}

// The ICS lines unfolded, with the first value of each property (enough for UID and SUMMARY).
function props(ics: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of ics.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)) {
    const m = /^([A-Z-]+)(?:;[^:]*)?:(.*)$/.exec(line);
    if (m && !out.has(m[1])) out.set(m[1], m[2]);
  }
  return out;
}
const unescIcs = (s: string) => s.replace(/\\n/gi, '\n').replace(/\\([;,\\])/g, '$1');

export async function listRemote(coll: string, cfg: CalConfig, fetchImpl: FetchLike, nowMs: number): Promise<Map<string, RemoteEvent> | null> {
  const z = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const body = '<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop>'
    + `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:prop-filter name="UID"><c:text-match collation="i;octet">${UID_PREFIX}</c:text-match></c:prop-filter>`
    + `<c:time-range start="${z(nowMs - 3 * 86_400_000)}" end="${z(nowMs + 30 * 86_400_000)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  const res = await fetchImpl(coll, { method: 'REPORT', headers: { ...cfg.auth, Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' }, body, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const out = new Map<string, RemoteEvent>();
  for (const r of responses(await res.text())) {
    const href = tag(r, 'href'), etag = tag(r, 'getetag'), data = tag(r, 'calendar-data');
    if (!href || !data) continue;
    const p = props(unxml(data));
    const date = dateOfUid(p.get('UID') ?? '');
    if (!date) continue;
    out.set(date, { href: new URL(unxml(href), coll).toString(), etag: unxml(etag ?? '').trim(), summary: unescIcs(p.get('SUMMARY') ?? '').trim() });
  }
  return out;
}

async function put(url: string, ics: string, cond: Record<string, string>, cfg: CalConfig, fetchImpl: FetchLike): Promise<FetchRes> {
  return fetchImpl(url, {
    method: 'PUT', headers: { ...cfg.auth, 'Content-Type': 'text/calendar; charset=utf-8', ...cond }, body: ics, signal: AbortSignal.timeout(15_000),
  });
}

export async function syncForecastCalendar(deps: SyncDeps): Promise<SyncResult> {
  const r: SyncResult = { status: 'off', created: 0, updated: 0, edits: 0, conflicts: 0, errors: 0 };
  const cfg = forecastCalConfig(deps.env);
  if (!cfg) return r;
  try {
    const state = await deps.readState();
    let coll = cfg.collection ?? state.collection ?? null;
    if (!coll) {
      coll = await discoverCollection(cfg, deps.fetchImpl);
      if (!coll) { console.error('[forecast-cal] calendar not found'); return { ...r, status: 'error', errors: 1 }; }
      state.collection = coll;
    }
    const remote = await listRemote(coll, cfg, deps.fetchImpl, deps.nowMs);
    if (!remote) {
      if (!cfg.collection) delete state.collection;   // a moved or renamed calendar is found again next time
      await deps.writeState(state);
      console.error('[forecast-cal] read failed');
      return { ...r, status: 'error', errors: 1 };
    }
    let want = await deps.buildWant();
    const edits = findEdits({ want, remote, state, listed: true });
    r.edits = edits.length;
    if (edits.length) {
      for (const e of edits) if (!e.unreadable) await deps.setNeed(e.day, e.need);
      if (edits.some((e) => !e.unreadable)) {
        await deps.forcePlan().catch(() => {});
        want = await deps.buildWant();   // the plan now reads the new need
      }
    }
    const actions = decideWrites({ want, remote, state, edits, listed: true });
    for (const a of actions) {
      const ics = buildIcs(a.day, deps.nowMs, a.note);
      const res = a.kind === 'create'
        ? await put(new URL(`${encodeURIComponent(uidFor(a.date))}.ics`, coll).toString(), ics, { 'If-None-Match': '*' }, cfg, deps.fetchImpl)
        : await put(a.href, ics, a.etag ? { 'If-Match': a.etag } : {}, cfg, deps.fetchImpl);
      if (res.status === 412) { r.conflicts++; continue; }   // changed meanwhile: read again next cycle
      if (!res.ok) { r.errors++; continue; }
      state.days[a.date] = { summary: summaryFor(a.day), etag: res.headers.get('ETag') ?? '', sig: signature(a.day, null) };
      if (a.kind === 'create') r.created++; else r.updated++;
    }
    const firstDate = want.length ? want[0].date : null;
    if (firstDate) for (const k of Object.keys(state.days)) if (k < firstDate) delete state.days[k];
    await deps.writeState(state);
    return { ...r, status: r.errors ? 'error' : 'ok' };
  } catch (e) {
    console.error('[forecast-cal] failed:', e instanceof Error ? e.name : 'error');
    return { ...r, status: 'error', errors: r.errors + 1 };
  }
}
