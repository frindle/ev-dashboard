// Shared ICS parsing for the shift calendar and the personal calendar (EV
// charge plan #8). Pure: node:test can load this file. Recurring events
// (RRULE) are not expanded.

const tzOffsetMs = (ms: number, tz: string): number => {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
};

// Wall-clock time in `tz` (process local when absent or unknown) -> epoch ms.
export function zonedMs(y: number, mo: number, d: number, h: number, mi: number, s: number, tz?: string): number {
  if (tz) {
    try {
      const guess = Date.UTC(y, mo, d, h, mi, s);
      const first = guess - tzOffsetMs(guess, tz);
      return guess - tzOffsetMs(first, tz);
    } catch { /* unknown TZID: fall through to local */ }
  }
  return new Date(y, mo, d, h, mi, s).getTime();
}

export interface IcsTime { ms: number; allDay: boolean }

// A DTSTART / DTEND line (TZID, UTC "Z", floating = local, VALUE=DATE = all-day).
export function parseIcsTime(line: string): IcsTime | null {
  const m = /^DT(?:START|END)((?:;[^:]*)?):(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/.exec(line);
  if (!m) return null;
  const [, params, y, mo, d, h, mi, s, z] = m;
  if (h === undefined) return { ms: new Date(+y, +mo - 1, +d).getTime(), allDay: true };
  if (z) return { ms: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s), allDay: false };
  const tz = /TZID=("?)([^;:"]+)\1/.exec(params)?.[2];
  return { ms: zonedMs(+y, +mo - 1, +d, +h, +mi, +s, tz), allDay: false };
}

// Unfolded lines of an ICS text.
export function unfoldIcs(ics: string): string[] {
  return ics.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

// Value of a content line: everything after the first colon outside quotes.
export function propValue(line: string): string {
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ':' && !q) return line.slice(i + 1);
  }
  return '';
}

export function unescapeText(s: string): string {
  return s.replace(/\\([nN,;\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

export interface LatLon { lat: number; lon: number }

const validPoint = (lat: number, lon: number): LatLon | null =>
  Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0)
    ? { lat, lon } : null;

export interface IcsEvent {
  uid: string;
  summary: string;
  start: IcsTime | null;
  end: IcsTime | null;
  cancelled: boolean;
  open: boolean;                 // CATEGORIES has "open shift"
  location: string;
  geo: LatLon | null;            // GEO:lat;lon
  structuredGeo: LatLon | null;  // X-APPLE-STRUCTURED-LOCATION ...:geo:lat,lon
  description: string;
}

const OPEN_SHIFT = /^CATEGORIES[;:].*\bopen[ -]?shift\b/i;

// Every VEVENT, with the properties the planners read. Components nested in
// an event (VALARM) are ignored.
export function parseIcsEvents(ics: string): IcsEvent[] {
  const out: IcsEvent[] = [];
  let depth = 0;
  let e: IcsEvent | null = null;
  for (const line of unfoldIcs(ics)) {
    if (line === 'BEGIN:VEVENT') {
      depth = 1;
      e = { uid: '', summary: '', start: null, end: null, cancelled: false, open: false, location: '', geo: null, structuredGeo: null, description: '' };
      continue;
    }
    if (!depth || !e) continue;
    if (line.startsWith('BEGIN:')) { depth++; continue; }
    if (line.startsWith('END:')) {
      if (--depth === 0) { out.push(e); e = null; }
      continue;
    }
    if (depth !== 1) continue;
    if (line.startsWith('DTSTART')) e.start = parseIcsTime(line);
    else if (line.startsWith('DTEND')) e.end = parseIcsTime(line);
    else if (/^SUMMARY[;:]/.test(line)) e.summary = line.slice(line.indexOf(':') + 1);
    else if (line.startsWith('UID:')) e.uid = line.slice(4);
    else if (OPEN_SHIFT.test(line)) e.open = true;
    else if (line.startsWith('STATUS:CANCELLED')) e.cancelled = true;
    else if (/^LOCATION[;:]/.test(line)) e.location = unescapeText(propValue(line)).trim();
    else if (/^DESCRIPTION[;:]/.test(line)) e.description = unescapeText(propValue(line));
    else if (line.startsWith('GEO:')) {
      const [a, b] = line.slice(4).split(';');
      e.geo = validPoint(parseFloat(a), parseFloat(b));
    } else if (line.startsWith('X-APPLE-STRUCTURED-LOCATION')) {
      const m = /geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i.exec(line);
      if (m) e.structuredGeo = validPoint(parseFloat(m[1]), parseFloat(m[2]));
    }
  }
  return out;
}
