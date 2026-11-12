// Pure daily-use math for the Rivian (EV charge plan #6). A day's use is that
// day's drive SoC drops plus its share of the parked drain. Between two charges
// the parked drain is (total SoC drop - drive drops), split evenly over the
// local calendar days from the first charge's day to the second's (inclusive;
// a charge day takes a share from each side, and the shares add up).
//
// Shared with scripts/roamer-seed.mjs, so the Roamer backfill and the live log
// use the identical split. Process-TZ local days (the container and the tests
// run in America/Los_Angeles).

export const MAX_SEGMENT_DAYS = 7;

export interface UseDrive {
  start: string;                 // ISO
  start_soc: number | null;
  end_soc: number | null;
  miles: number;
}

export interface UseCharge {
  start: string;                 // ISO
  end: string;                   // ISO
  start_soc: number | null;
  end_soc: number | null;
}

export interface DailyUseRow {
  date: string;                  // YYYY-MM-DD, local
  unknown: boolean;              // no polls that day, or the day sits in a segment with one
  used_pct: number | null;
  drive_pct: number | null;
  parked_pct: number | null;
  drives: number;
  miles: number;
}

export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + 1, 12).getTime());
}

function datesBetween(a: string, b: string): string[] {
  const out: string[] = [];
  for (let d = a; d <= b; d = addDay(d)) out.push(d);
  return out;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

// pollDays: local dates that had at least one poll. null = every day counts as
// known (the Roamer seed has no poll record; its gaps are dropped by the
// 7-day rule instead).
export function computeDailyUse(
  drives: UseDrive[], charges: UseCharge[], pollDays: ReadonlySet<string> | null,
): DailyUseRow[] {
  const cs = charges
    .filter((c) => Number.isFinite(Date.parse(c.start)) && Number.isFinite(Date.parse(c.end)))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const ds = drives
    .filter((d) => Number.isFinite(Date.parse(d.start)))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  const byDate = new Map<string, DailyUseRow>();
  const row = (date: string): DailyUseRow => {
    let r = byDate.get(date);
    if (!r) { r = { date, unknown: false, used_pct: 0, drive_pct: 0, parked_pct: 0, drives: 0, miles: 0 }; byDate.set(date, r); }
    return r;
  };

  for (let i = 0; i + 1 < cs.length; i++) {
    const a = cs[i], b = cs[i + 1];
    const t1 = Date.parse(a.end), t2 = Date.parse(b.start);
    if (!(t2 > t1) || t2 - t1 > MAX_SEGMENT_DAYS * 86_400_000) continue;
    if (a.end_soc === null || b.start_soc === null) continue;
    const total = a.end_soc - b.start_soc;
    if (total < 0) continue;                       // charged elsewhere in between
    const dates = datesBetween(localDate(t1), localDate(t2));
    const inSeg = ds.filter((d) => { const t = Date.parse(d.start); return t >= t1 && t < t2; });
    // A day with no polls means drives may be missing, so the residual can't
    // be called parked drain: the whole segment is unknown.
    const unknown = pollDays !== null && dates.some((d) => !pollDays.has(d));
    if (unknown) {
      for (const d of dates) { const r = row(d); r.unknown = true; }
      continue;
    }
    let driveTotal = 0;
    for (const d of inSeg) {
      if (d.start_soc === null || d.end_soc === null) continue;
      const drop = Math.max(0, d.start_soc - d.end_soc);
      driveTotal += drop;
      const r = row(localDate(Date.parse(d.start)));
      r.drive_pct! += drop;
      r.drives += 1;
      r.miles += d.miles;
    }
    const parked = Math.max(0, total - driveTotal);
    const share = parked / dates.length;
    for (const d of dates) row(d).parked_pct! += share;
  }

  return [...byDate.values()]
    .sort((x, y) => (x.date < y.date ? -1 : 1))
    .map((r) => {
      if (r.unknown) return { ...r, used_pct: null, drive_pct: null, parked_pct: null };
      const drive = r2(r.drive_pct!), parked = r2(r.parked_pct!);
      return { ...r, drive_pct: drive, parked_pct: parked, used_pct: r2(drive + parked), miles: r2(r.miles) };
    });
}
