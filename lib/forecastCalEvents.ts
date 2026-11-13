// The "EV Charge Forecast" Nextcloud calendar, pure parts (the I/O is lib/forecastCalSync.ts): one
// all-day event per day whose title is the day's driving, editable. Building the event, reading a
// title back, and deciding what to write. Only numbers and times go in an event: never a personal
// event title, place or coordinate.
import { foldLine } from './caldavWriteback.ts';
import { MANUAL_MAX, type ManualNeed } from './tripStore.ts';

export type { ManualNeed };

export interface ForecastNight {
  plug: boolean | null;         // null: SoC unknown
  amps: number | null;
  windowHours: number;
  morningPct: number | null;
  arrivalPct: number | null;
}

export interface ForecastDayIn {
  date: string;                 // YYYY-MM-DD, local
  day: number;                  // local day number
  miles: number | null;
  pct: number | null;           // expected use, % of the battery, no margin
  source: string;               // typed | trip | work model | day-off average | charge history | default
  highF: number | null;
  typed: ManualNeed | null;
  typedBelow: boolean;          // typed under the forecast: ignored, the title shows the forecast
  away: boolean;
  night: ForecastNight | null;
}

export const UID_PREFIX = 'ev-need-';
export const uidFor = (date: string) => `${UID_PREFIX}${date}@home-dashboards`;
export const dateOfUid = (uid: string): string | null => /^ev-need-(\d{4}-\d{2}-\d{2})@home-dashboards$/.exec(uid.trim())?.[1] ?? null;

// SUMMARY: "EV 34 mi" is the forecast; a typed need above it is "EV 60 mi (set)" / "EV 25% (set)";
// one below it is ignored and says so: "EV 34 mi (set 20, below forecast)".
export function summaryFor(d: Pick<ForecastDayIn, 'miles' | 'pct' | 'typed' | 'typedBelow' | 'away'>): string {
  if (d.typed && d.typedBelow) return `EV ${d.miles ?? '?'} mi (set ${d.typed.value}${d.typed.unit === 'pct' ? '%' : ''}, below forecast)`;
  if (d.typed) return d.typed.unit === 'pct' ? `EV ${d.typed.value}% (set)` : `EV ${d.typed.value} mi (set)`;
  if (d.away) return 'EV away';
  if (d.miles !== null) return `EV ${d.miles} mi`;
  return d.pct !== null ? `EV ${Math.round(d.pct)}%` : 'EV ?';
}

export type TitleEdit =
  | { kind: 'auto' }
  | { kind: 'need'; need: ManualNeed }
  | { kind: 'unreadable' };

// Reads a title Penn typed: 'auto' / 'forecast' = back to the forecast; else the first number,
// % or "pct"/"percent" after it = percent, anything else (mi, miles, nothing) = miles.
export function parseTitle(summary: string): TitleEdit {
  const t = summary.trim().toLowerCase();
  const m = /(\d+(?:\.\d+)?)\s*(%|pct\b|percent\b)?/.exec(t);
  // 'auto' only when no number: "EV 50 mi (set 20, below forecast)" is 50 mi, not auto.
  if (!m) return /\b(auto|forecast)\b/.test(t) ? { kind: 'auto' } : { kind: 'unreadable' };
  const unit: ManualNeed['unit'] = m[2] ? 'pct' : 'mi';
  const value = Math.round(Number(m[1]));
  if (!Number.isFinite(value) || value <= 0 || value > MANUAL_MAX[unit]) return { kind: 'unreadable' };
  return { kind: 'need', need: { value, unit } };
}

const pct0 = (n: number | null) => (n === null ? '?' : `${Math.round(n)}%`);

// The lines of the description that say what the forecast is (a change here rewrites the event).
export function bodyLines(d: ForecastDayIn, note: string | null): string[] {
  const use = d.away ? 'away on a trip, no charging at home planned'
    : `${d.miles ?? '?'} mi (${pct0(d.pct)} of the battery), ${d.source}${d.highF !== null ? `, high ${Math.round(d.highF)}F` : ''}`;
  const lines = [`Forecast driving: ${use}`];
  const n = d.night;
  if (n) {
    if (n.windowHours <= 0) lines.push('Night before: no charge window.');
    else if (n.plug === null) lines.push(`Night before: ${n.windowHours.toFixed(1)}h window, car charge level unknown.`);
    else if (!n.plug) lines.push(`Night before: no need to plug in (${pct0(n.morningPct)} in the morning, ${pct0(n.arrivalPct)} on getting home).`);
    else lines.push(`Night before: plug in, ${n.amps}A over ${n.windowHours.toFixed(1)}h, ${pct0(n.morningPct)} in the morning, ${pct0(n.arrivalPct)} on getting home.`);
  }
  if (note) lines.push(note);
  lines.push("Raise this day's miles by changing the number in the title (e.g. EV 60 mi or EV 25%). It only raises the plan: a number below the forecast is ignored. Delete the event or type 'auto' to go back to the forecast.");
  return lines;
}

// What a rewrite is compared on: the summary and the description without its updated time.
export const signature = (d: ForecastDayIn, note: string | null): string => `${summaryFor(d)}|${bodyLines(d, note).join('|')}`;

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/[;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n');
const compact = (date: string) => date.replace(/-/g, '');
export function nextDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

export function buildIcs(d: ForecastDayIn, nowMs: number, note: string | null = null): string {
  const updated = new Date(nowMs).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//home-dashboards//EV charge forecast//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uidFor(d.date)}`,
    `DTSTAMP:${stamp(nowMs)}`,
    `DTSTART;VALUE=DATE:${compact(d.date)}`,
    `DTEND;VALUE=DATE:${compact(nextDate(d.date))}`,
    `SUMMARY:${esc(summaryFor(d))}`,
    `DESCRIPTION:${esc([...bodyLines(d, note), `Updated ${updated}`].join('\n'))}`,
    'TRANSP:TRANSPARENT',
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

// ---- what to do with the remote events -------------------------------------------------

export interface RemoteEvent { href: string; etag: string; summary: string }
export interface SyncedDay { summary: string; etag: string; sig: string }
export type SyncState = { collection?: string; days: Record<string, SyncedDay> };

export type NeedEdit = { date: string; day: number; need: ManualNeed | null; unreadable: boolean };

// Penn's changes since the last cycle: a title that differs from the one written, or a written
// event that is gone (deleted = back to the forecast). `listed` false (the read failed) finds none.
export function findEdits(p: { want: ForecastDayIn[]; remote: Map<string, RemoteEvent>; state: SyncState; listed: boolean }): NeedEdit[] {
  if (!p.listed) return [];
  const out: NeedEdit[] = [];
  for (const d of p.want) {
    const was = p.state.days[d.date];
    if (!was) continue;                                   // nothing written yet: nothing to compare with
    const r = p.remote.get(d.date);
    if (!r) { out.push({ date: d.date, day: d.day, need: null, unreadable: false }); continue; }
    if (r.summary === was.summary) continue;
    const e = parseTitle(r.summary);
    if (e.kind === 'need') out.push({ date: d.date, day: d.day, need: e.need, unreadable: false });
    else if (e.kind === 'auto') out.push({ date: d.date, day: d.day, need: null, unreadable: false });
    else out.push({ date: d.date, day: d.day, need: null, unreadable: true });   // leave the need as is
  }
  return out;
}

export type WriteAction =
  | { kind: 'create'; date: string; day: ForecastDayIn; note: null }
  | { kind: 'update'; date: string; day: ForecastDayIn; href: string; etag: string; note: string | null };

export const UNREADABLE_NOTE = "Couldn't read that title, so the plan is unchanged. Use a number above 0: EV 60 mi, EV 25%, or 'auto'.";

// Writes only where the content changed: new days, edited days (rewritten normalized), and days
// whose forecast moved. `edits` are the ones findEdits returned, already applied to `want`.
export function decideWrites(p: { want: ForecastDayIn[]; remote: Map<string, RemoteEvent>; state: SyncState; edits: NeedEdit[]; listed: boolean }): WriteAction[] {
  if (!p.listed) return [];
  const edited = new Map(p.edits.map((e) => [e.date, e]));
  const out: WriteAction[] = [];
  for (const d of p.want) {
    const r = p.remote.get(d.date);
    const e = edited.get(d.date);
    if (!r) { out.push({ kind: 'create', date: d.date, day: d, note: null }); continue; }
    const was = p.state.days[d.date];
    const note = e?.unreadable ? UNREADABLE_NOTE : null;
    if (e || !was || r.summary !== was.summary || was.sig !== signature(d, null)) {
      out.push({ kind: 'update', date: d.date, day: d, href: r.href, etag: r.etag, note });
    }
  }
  return out;
}
