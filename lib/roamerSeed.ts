// Turns Roamer's drive and charge CSV exports into rivian-drives.jsonl and
// rivian-daily-use.jsonl rows (EV charge plan #6, the Roamer seed). Pure:
// scripts/roamer-seed.mjs does the file IO. Location, altitude, odometer,
// weather text and tags are never read into a row.
import { parseCsv } from './csv.ts';
import { parseTimestamp } from './pacificTime.ts';
import { MIN_DRIVE_MI, type DriveRecord } from './rivianDriveLog.ts';
import { computeDailyUse, type DailyUseRow, type UseCharge } from './rivianDailyUse.ts';

export interface SeedResult {
  drives: DriveRecord[];
  daily: DailyUseRow[];
  charges: UseCharge[];
  skipped: { corrupted: number; short: number; incomplete: number };
}

type Table = { header: string[]; rows: string[][] };

function table(text: string, what: string): Table {
  const all = parseCsv(text.replace(/^﻿/, ''));
  if (!all.length) throw new Error(`${what}: empty file`);
  return { header: all[0].map((h) => h.trim()), rows: all.slice(1) };
}

// Exact header first, then "starts with" (the time columns end in a time-zone note).
function col(t: Table, name: string, required = true): number {
  let i = t.header.indexOf(name);
  if (i < 0) i = t.header.findIndex((h) => h.startsWith(name));
  if (i < 0 && required) throw new Error(`missing column: ${name}`);
  return i;
}

function num(s: string | undefined): number | null {
  if (s === undefined || s.trim() === '') return null;
  const x = Number(s.trim());
  return Number.isFinite(x) ? x : null;
}

const truthy = (s: string | undefined) => /^(true|1|yes|y|t)$/i.test((s ?? '').trim());

export function seedFromRoamer(drivesCsv: string, chargesCsv: string, since: string | null = null): SeedResult {
  const sinceMs = since ? Date.parse(`${since}T00:00:00-08:00`) : null;
  const skipped = { corrupted: 0, short: 0, incomplete: 0 };

  const dt = table(drivesCsv, 'drive_sessions');
  const dStart = col(dt, 'Started At'), dEnd = col(dt, 'Ended At'), dMiles = col(dt, 'Distance (mi)');
  const dS = col(dt, 'Start Battery (%)'), dE = col(dt, 'End Battery (%)');
  const dTemp = col(dt, 'Start Temperature (F)', false), dBad = col(dt, 'Corrupted', false);
  const drives: DriveRecord[] = [];
  for (const r of dt.rows) {
    if (r.every((c) => c.trim() === '')) continue;
    if (dBad >= 0 && truthy(r[dBad])) { skipped.corrupted++; continue; }
    const miles = num(r[dMiles]);
    if (miles === null || !r[dStart]?.trim() || !r[dEnd]?.trim()) { skipped.incomplete++; continue; }
    if (miles < MIN_DRIVE_MI) { skipped.short++; continue; }
    const start = parseTimestamp(r[dStart]), end = parseTimestamp(r[dEnd]);
    if (sinceMs !== null && start < sinceMs) continue;
    drives.push({
      start: new Date(start).toISOString(), end: new Date(end).toISOString(),
      start_soc: num(r[dS]), end_soc: num(r[dE]),
      miles: Math.round(miles * 10) / 10,
      at_home: null, end_at_home: null,
      temp_f: dTemp >= 0 ? num(r[dTemp]) : null,
      start_cell: null, end_cell: null,
    });
  }
  drives.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  const ct = table(chargesCsv, 'charge_sessions');
  const cStart = col(ct, 'Started At'), cEnd = col(ct, 'Ended At');
  const cS = col(ct, 'Start Battery (%)'), cE = col(ct, 'End Battery (%)');
  const cBad = col(ct, 'Corrupted', false);
  const charges: UseCharge[] = [];
  for (const r of ct.rows) {
    if (r.every((c) => c.trim() === '')) continue;
    if (cBad >= 0 && truthy(r[cBad])) { skipped.corrupted++; continue; }
    if (!r[cStart]?.trim() || !r[cEnd]?.trim()) { skipped.incomplete++; continue; }
    const start = parseTimestamp(r[cStart]), end = parseTimestamp(r[cEnd]);
    if (sinceMs !== null && start < sinceMs) continue;
    charges.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString(), start_soc: num(r[cS]), end_soc: num(r[cE]) });
  }

  return { drives, charges, daily: computeDailyUse(drives, charges, null), skipped };
}
