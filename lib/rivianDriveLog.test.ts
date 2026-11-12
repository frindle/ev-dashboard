// Run: node --experimental-strip-types --test lib/rivianDriveLog.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialDriveState, stepDriveLog, type DrivePoll, type DriveRecord, type DriveState } from './rivianDriveLog.ts';

const T0 = Date.parse('2026-11-02T15:00:00Z');
const MIN = 60_000;

function poll(min: number, gear: string, over: Partial<DrivePoll> = {}): DrivePoll {
  return { ms: T0 + min * MIN, gear, soc: 80, odometerMi: 1000, atHome: null, tempF: null, cell: null, ...over };
}

function run(polls: DrivePoll[]) {
  let state: DriveState = initialDriveState();
  const drives: DriveRecord[] = [];
  const dropped: (string | null)[] = [];
  for (const p of polls) {
    const r = stepDriveLog(state, p);
    state = r.state;
    if (r.drive) drives.push(r.drive);
    if (r.dropped) dropped.push(r.dropped);
  }
  return { drives, dropped, state };
}

test('P -> D -> P makes one drive with start/end SoC, miles, temp and home flags', () => {
  const { drives } = run([
    poll(0, 'park', { atHome: true, soc: 80, odometerMi: 1000, cell: 'aaa' }),
    poll(2, 'drive', { atHome: true, soc: 80, odometerMi: 1000.1, tempF: 61 }),
    poll(12, 'drive', { atHome: false, soc: 74, odometerMi: 1006 }),
    poll(22, 'park', { atHome: false, soc: 70, odometerMi: 1012.34, cell: 'bbb' }),
  ]);
  assert.equal(drives.length, 1);
  const d = drives[0];
  // start values come from the last parked poll (2 min before the first drive poll)
  assert.equal(d.start, new Date(T0).toISOString());
  assert.equal(d.end, new Date(T0 + 22 * MIN).toISOString());
  assert.equal(d.start_soc, 80);
  assert.equal(d.end_soc, 70);
  assert.equal(d.miles, 12.3);
  assert.equal(d.at_home, true);
  assert.equal(d.end_at_home, false);
  assert.equal(d.temp_f, 61);
  assert.equal(d.start_cell, 'aaa');
  assert.equal(d.end_cell, 'bbb');
});

test('reverse and neutral count as not in P', () => {
  const { drives } = run([
    poll(0, 'park'), poll(1, 'reverse'), poll(2, 'neutral', { odometerMi: 1002 }), poll(3, 'park', { odometerMi: 1003 }),
  ]);
  assert.equal(drives.length, 1);
  assert.equal(drives[0].miles, 3);
});

test('a drive under 0.5 mi is dropped', () => {
  const { drives, dropped } = run([
    poll(0, 'park'), poll(1, 'drive', { odometerMi: 1000.1 }), poll(2, 'park', { odometerMi: 1000.4 }),
  ]);
  assert.equal(drives.length, 0);
  assert.deepEqual(dropped, ['short']);
});

test('exactly 0.5 mi is kept', () => {
  const { drives } = run([poll(0, 'park'), poll(1, 'drive'), poll(2, 'park', { odometerMi: 1000.5 })]);
  assert.equal(drives.length, 1);
});

test('a poll gap over 30 min mid-drive drops the drive and waits for P', () => {
  const { drives, dropped, state } = run([
    poll(0, 'park'), poll(1, 'drive', { odometerMi: 1001 }),
    poll(60, 'drive', { odometerMi: 1030 }),        // 59 min later: gap
    poll(70, 'drive', { odometerMi: 1035 }),        // still driving, ignored: no trustworthy start
    poll(80, 'park', { odometerMi: 1040 }),
  ]);
  assert.equal(drives.length, 0);
  assert.deepEqual(dropped, ['gap']);
  assert.equal(state.open, null);
  assert.ok(state.lastParked);
});

test('a short gap mid-drive is fine', () => {
  const { drives } = run([
    poll(0, 'park'), poll(1, 'drive', { odometerMi: 1001 }), poll(20, 'drive', { odometerMi: 1010 }), poll(25, 'park', { odometerMi: 1015 }),
  ]);
  assert.equal(drives.length, 1);
  assert.equal(drives[0].miles, 15);
});

test('after a dropped gap drive, the next P-then-drive logs normally', () => {
  const { drives } = run([
    poll(0, 'park'), poll(1, 'drive'), poll(90, 'drive'), poll(95, 'park', { odometerMi: 1000 }),
    poll(100, 'drive', { odometerMi: 1000 }), poll(110, 'park', { odometerMi: 1008 }),
  ]);
  assert.equal(drives.length, 1);
  assert.equal(drives[0].miles, 8);
});

test('a drive seen with no earlier parked poll (restart mid-drive) is not logged', () => {
  const { drives } = run([poll(0, 'drive', { odometerMi: 1000 }), poll(5, 'park', { odometerMi: 1005 })]);
  assert.equal(drives.length, 0);
});

test('missing odometer drops the drive; unknown gear changes nothing', () => {
  const r = run([
    poll(0, 'park', { odometerMi: null }), poll(1, 'drive', { odometerMi: null }), poll(2, '', { odometerMi: null }),
    poll(3, 'park', { odometerMi: null }),
  ]);
  assert.equal(r.drives.length, 0);
  assert.deepEqual(r.dropped, ['no_odometer']);
});

test('old parked poll: start comes from the first drive poll', () => {
  const { drives } = run([
    poll(0, 'park', { soc: 90 }), poll(60, 'drive', { soc: 85, odometerMi: 1000 }), poll(70, 'park', { soc: 80, odometerMi: 1005 }),
  ]);
  assert.equal(drives[0].start_soc, 85);
  assert.equal(drives[0].start, new Date(T0 + 60 * MIN).toISOString());
});

test('drive rows carry no location, odometer or address keys', () => {
  const { drives } = run([
    poll(0, 'park', { cell: 'abc123' }), poll(1, 'drive'), poll(9, 'park', { odometerMi: 1009, cell: 'def456' }),
  ]);
  const keys = Object.keys(drives[0]).join(',');
  assert.ok(!/lat|lon|odometer|odo|address|gps|coord/i.test(keys), keys);
});
