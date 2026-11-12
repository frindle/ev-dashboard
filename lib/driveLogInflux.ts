// Influx lines for the drive and daily-use logs (EV charge plan #6): ev_drive
// and ev_daily_use. Same rules as chargeSessionInflux.ts: the jsonl is the
// truth, Influx is a best-effort copy, same measurement + tags + timestamp
// overwrites. No coordinates, odometer or map cells ever go in a line.
import { influxTarget, writeLines } from './chargeSessionInflux.ts';
import type { DriveRecord } from './rivianDriveLog.ts';
import type { DailyUseRow } from './rivianDailyUse.ts';

export const DRIVE_MEASUREMENT = 'ev_drive';
export const DAILY_USE_MEASUREMENT = 'ev_daily_use';

type FetchLike = Parameters<typeof writeLines>[2];

function num(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

export function driveLine(d: DriveRecord, vehicle = 'rivian'): string | null {
  const ts = Date.parse(d.start);
  if (!Number.isFinite(ts)) return null;
  const fields: string[] = [];
  const add = (name: string, v: number | null) => { if (v !== null) fields.push(`${name}=${v}`); };
  add('miles', num(d.miles));
  add('start_soc', num(d.start_soc));
  add('end_soc', num(d.end_soc));
  const end = Date.parse(d.end);
  add('duration_min', Number.isFinite(end) && end >= ts ? Math.round((end - ts) / 600) / 100 : null);
  add('temp_f', num(d.temp_f));
  if (typeof d.at_home === 'boolean') fields.push(`at_home=${d.at_home ? 1 : 0}`);
  if (typeof d.end_at_home === 'boolean') fields.push(`end_at_home=${d.end_at_home ? 1 : 0}`);
  if (!fields.length) return null;
  return `${DRIVE_MEASUREMENT},vehicle=${vehicle} ${fields.join(',')} ${ts}`;
}

// Timestamp: local noon of the day, so it is stable across DST.
export function dailyUseLine(r: DailyUseRow, vehicle = 'rivian'): string | null {
  if (r.unknown || r.used_pct === null) return null;
  const [y, m, d] = r.date.split('-').map(Number);
  const ts = new Date(y, m - 1, d, 12).getTime();
  if (!Number.isFinite(ts)) return null;
  const fields = [`used_pct=${r.used_pct}`, `drive_pct=${r.drive_pct}`, `parked_pct=${r.parked_pct}`, `drives=${r.drives}`, `miles=${r.miles}`];
  return `${DAILY_USE_MEASUREMENT},vehicle=${vehicle} ${fields.join(',')} ${ts}`;
}

// Never throws; returns the number of lines written.
export async function writeInfluxLines(
  lines: (string | null)[],
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: FetchLike,
): Promise<number> {
  try {
    const target = influxTarget(env);
    const ok = lines.filter((l): l is string => !!l);
    if (!target || !ok.length) return 0;
    return await writeLines(ok, target, fetchImpl, 5_000);
  } catch (e) {
    console.error('[drive-log] influx write failed:', e instanceof Error ? e.message : e);
    return 0;
  }
}
