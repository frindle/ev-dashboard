// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/driveLog.test.ts
// Covers the small pure pieces of #6 that don't have a test file of their own:
// kwhPerPct, packKwh, session stats, cells, and the "no location in any row" rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KWH_PER_PCT_SEED, measuredKwhPerPct } from './kwhPerPct.ts';
import { packKwhFor } from './packKwh.ts';
import { cellId, hashCell } from './driveCell.ts';
import { finishStats, startStats, stepStats } from './chargeSessionStats.ts';
import { dailyUseLine, driveLine } from './driveLogInflux.ts';
import { sessionLine } from './chargeSessionInflux.ts';
import { appendDrive, driveCellSalt, markPollDay, readDrives, refreshDailyUse } from './driveLogStore.ts';
import { initialDriveState, stepDriveLog, type DriveRecord } from './rivianDriveLog.ts';

const row = (i: number, kwh: number, s: number | null, e: number | null) =>
  ({ startedAt: new Date(Date.UTC(2026, 5, 1 + i)).toISOString(), energyKwh: kwh, startSoc: s, endSoc: e });

test('kwhPerPct: no sessions -> the seed', () => {
  assert.equal(measuredKwhPerPct([]), KWH_PER_PCT_SEED);
  assert.equal(measuredKwhPerPct([row(0, 10, null, null)]), 1.44);
});

test('kwhPerPct: a few real sessions are padded with the seed, then the median wins', () => {
  // two samples at 1.6 + three seeds of 1.44 -> median 1.44
  assert.equal(measuredKwhPerPct([row(0, 32, 30, 50), row(1, 16, 40, 50)]), 1.44);
  // six samples all 1.6 -> 1.6
  const six = [0, 1, 2, 3, 4, 5].map((i) => row(i, 32, 30, 50));
  assert.equal(measuredKwhPerPct(six), 1.6);
});

test('kwhPerPct: ignores < 10% sessions, glitches, and uses only the last 20', () => {
  const small = [0, 1, 2, 3, 4, 5].map((i) => row(i, 5, 50, 55));          // 5% gained: skipped
  assert.equal(measuredKwhPerPct(small), 1.44);
  const glitch = [0, 1, 2, 3, 4, 5].map((i) => row(i, 200, 30, 50));        // 10 kWh/% : skipped
  assert.equal(measuredKwhPerPct(glitch), 1.44);
  const old = Array.from({ length: 10 }, (_, i) => row(i, 20, 30, 50));      // 1.0, oldest
  const recent = Array.from({ length: 20 }, (_, i) => row(100 + i, 36, 30, 50)); // 1.8
  assert.equal(measuredKwhPerPct([...old, ...recent]), 1.8);
});

test('kwhPerPct: custom seed', () => {
  assert.equal(measuredKwhPerPct([], 1.5), 1.5);
});

test('packKwh: live value, then config, then fallback', () => {
  assert.equal(packKwhFor(131.2, 124.5, 135), 131.2);
  assert.equal(packKwhFor(null, 124.5, 135), 124.5);
  assert.equal(packKwhFor(undefined, null, 135), 135);
  assert.equal(packKwhFor(0, 124.5, 135), 124.5);      // not reported
  assert.equal(packKwhFor(5000, null, 124.5), 124.5);  // implausible
});

test('session stats: start/end SoC and time-weighted avg + peak kW', () => {
  let s = startStats(41.5);
  s = stepStats(s, 10, 30);
  s = stepStats(s, 4, 30);
  assert.deepEqual(finishStats(s, 67), { startSoc: 41.5, endSoc: 67, avgKw: 7, peakKw: 10 });
  assert.deepEqual(finishStats(startStats(0), 0), {});   // SoC 0 = not reported, no samples
});

test('cells: ~600 m grid, stable, salted', () => {
  assert.equal(cellId(36.1, -115.1), cellId(36.1001, -115.1001));
  assert.notEqual(cellId(36.1, -115.1), cellId(36.12, -115.1));
  const a = hashCell('salt-a', 36.1, -115.1), b = hashCell('salt-b', 36.1, -115.1);
  assert.match(a, /^[0-9a-f]{24}$/);
  assert.notEqual(a, b);
  assert.equal(a, hashCell('salt-a', 36.1001, -115.1001));
});

test('charge session line carries the new fields only when present (old rows unchanged)', () => {
  const base = { side: 'RIGHT' as const, vehicleName: 'Midknight', startedAt: '2026-06-01T08:00:00Z', endedAt: '2026-06-01T09:00:00Z', durationMin: 60, energyKwh: 10 };
  assert.equal(sessionLine(base, 'rivian'), 'ev_charge_session,side=RIGHT,vehicle=rivian energy_kwh=10,duration_min=60 1780300800000');
  assert.equal(
    sessionLine({ ...base, startSoc: 40, endSoc: 47, avgKw: 9.6, peakKw: 11.5 }, 'rivian'),
    'ev_charge_session,side=RIGHT,vehicle=rivian energy_kwh=10,duration_min=60,start_soc=40,end_soc=47,avg_kw=9.6,peak_kw=11.5 1780300800000',
  );
});

test('written rows and lines never contain location, odometer or raw cells', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drivelog-'));
  process.env.KEYS_DIR = dir;
  const salt = await driveCellSalt();
  assert.equal(salt.length, 32);
  assert.match(readFileSync(join(dir, 'drive-cell-salt'), 'utf-8'), /^[0-9a-f]{64}$/);

  const lat = 36.123456, lon = -115.654321;
  const cellA = hashCell(salt, lat, lon), cellB = hashCell(salt, lat + 0.05, lon);
  let state = initialDriveState();
  let drive: DriveRecord | null = null;
  const T = Date.parse('2026-01-10T17:00:00Z');
  const seq = [
    { ms: T, gear: 'park', odometerMi: 31829.1, soc: 80, cell: cellA },
    { ms: T + 60_000, gear: 'drive', odometerMi: 31829.2, soc: 80, cell: cellA },
    { ms: T + 900_000, gear: 'park', odometerMi: 31840.1, soc: 74, cell: cellB },
  ];
  for (const p of seq) {
    const r = stepDriveLog(state, { atHome: true, tempF: 55, ...p });
    state = r.state;
    if (r.drive) drive = r.drive;
  }
  assert.ok(drive);
  await appendDrive(drive!);
  await markPollDay('2026-01-10');
  await refreshDailyUse([
    { start: '2026-01-10T08:00:00Z', end: '2026-01-10T14:00:00Z', start_soc: 40, end_soc: 80 },
    { start: '2026-01-11T08:00:00Z', end: '2026-01-11T14:00:00Z', start_soc: 60, end_soc: 80 },
  ]);

  const files = readdirSync(dir).filter((f) => f.startsWith('rivian-'));
  assert.ok(files.includes('rivian-drives.jsonl'));
  const bad = /lat|lon|odometer|odo|address|gps|coord|36\.1|115\.6|31829|31840/i;
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf-8');
    assert.ok(!bad.test(text), `${f}: ${text}`);
  }
  const saved = (await readDrives())[0];
  assert.equal(saved.start_cell, cellA);
  assert.match(saved.end_cell!, /^[0-9a-f]{24}$/);
  assert.ok(existsSync(join(dir, 'rivian-daily-use.jsonl')));

  // Influx lines: no cells, no coordinates.
  const line = driveLine(saved)!;
  assert.ok(line.startsWith('ev_drive,vehicle=rivian miles='), line);
  assert.ok(!line.includes(cellA) && !line.includes(cellB) && !/cell|lat|lon|odo/i.test(line), line);
  assert.match(line, /at_home=1,end_at_home=1 /);
  assert.equal(dailyUseLine({ date: '2026-01-10', unknown: true, used_pct: null, drive_pct: null, parked_pct: null, drives: 0, miles: 0 }), null);
  assert.match(dailyUseLine({ date: '2026-01-10', unknown: false, used_pct: 12, drive_pct: 11, parked_pct: 1, drives: 2, miles: 30 })!, /^ev_daily_use,vehicle=rivian used_pct=12,drive_pct=11,parked_pct=1,drives=2,miles=30 \d+$/);
});
