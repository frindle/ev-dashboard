// Pacific wall-clock <-> UTC without depending on the process time zone, plus
// the timestamp formats the CSV imports accept. DST: a wall time that repeats
// in November resolves by `occurrence` (0 = first = PDT, 1 = second = PST); one
// that never happens in March resolves to null.
const TZ = 'America/Los_Angeles';

let fmt: Intl.DateTimeFormat | null = null;
function localParts(ms: number): string {
  fmt ??= new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function pacificToMs(
  y: number, mo: number, d: number, h: number, mi: number, s: number, occurrence: 0 | 1 = 0,
): number | null {
  const want = `${pad(y, 4)}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}:${pad(s)}`;
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const found: number[] = [];
  for (const offH of [7, 8]) {                      // PDT, PST
    const cand = asUtc + offH * 3_600_000;
    if (localParts(cand) === want) found.push(cand);
  }
  found.sort((a, b) => a - b);
  if (!found.length) return null;
  return found.length === 2 ? found[occurrence] : found[0];
}

// '2026-05-06T14:03:22Z' / '...+00:00' / '...' (Pacific), '2026-05-06 14:03[:22]',
// '5/6/2026 2:03[:22] PM' (also 24-hour '5/6/2026 14:03'). Anything else throws.
// Pacific wall times that never exist (spring-forward gap) throw too.
export function parseTimestamp(text: string, occurrence: 0 | 1 = 0): number {
  const t = text.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(t);
  if (m) {
    const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
    const s = m[6] ? Number(m[6]) : 0;
    if (m[7]) {
      const zone = m[7] === 'Z' ? 'Z' : m[7].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
      const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${pad(s)}${zone}`);
      if (Number.isFinite(ms)) return ms;
    } else {
      const ms = pacificToMs(y, mo, d, h, mi, s, occurrence);
      if (ms !== null) return ms;
    }
    throw new Error(`unparseable timestamp: ${JSON.stringify(t)}`);
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AaPp])\.?[Mm]\.?)?$/.exec(t);
  if (m) {
    const mo = Number(m[1]), d = Number(m[2]), y = Number(m[3]);
    let h = Number(m[4]);
    const mi = Number(m[5]), s = m[6] ? Number(m[6]) : 0;
    if (m[7]) {
      if (h < 1 || h > 12) throw new Error(`unparseable timestamp: ${JSON.stringify(t)}`);
      h = (h % 12) + (m[7].toLowerCase() === 'p' ? 12 : 0);
    }
    if (h > 23 || mi > 59 || s > 59 || mo < 1 || mo > 12 || d < 1 || d > 31) throw new Error(`unparseable timestamp: ${JSON.stringify(t)}`);
    const ms = pacificToMs(y, mo, d, h, mi, s, occurrence);
    if (ms !== null) return ms;
  }
  throw new Error(`unparseable timestamp: ${JSON.stringify(t)}`);
}

// Local Pacific calendar date and clock of an instant.
export function pacificFields(ms: number): { date: string; hour: number; minute: number } {
  const p = localParts(ms);
  return { date: p.slice(0, 10), hour: Number(p.slice(11, 13)), minute: Number(p.slice(14, 16)) };
}
