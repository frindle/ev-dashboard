// Pure drive state machine for the Rivian (EV charge plan #6). Fed one poll at
// a time by lib/rivianDriveRunner.ts; no IO and no clock, so node:test can load
// it. A drive runs from leaving P until the car is back in P. Drives under
// MIN_DRIVE_MI (or with no odometer reading) are dropped.
//
// Privacy: the machine never sees a latitude or longitude. `cell` is an opaque,
// already-salted-and-hashed string chosen by the caller, and odometer readings
// only live in memory long enough to turn into `miles`.

export const MIN_DRIVE_MI = 0.5;
// A drive with a gap this long between two polls is dropped: the car may have
// parked and gone again unseen, so its miles and SoC drop can't be trusted.
export const MAX_DRIVE_GAP_MS = 30 * 60_000;
// The last parked poll supplies the drive's start values when it is this recent.
export const START_BACKFILL_MS = 10 * 60_000;

export interface DrivePoll {
  ms: number;
  gear: string;                 // raw gearStatus: 'park' | 'drive' | 'reverse' | 'neutral' | ''
  powerState?: string;          // raw powerState; 'sleep' counts as parked when gear is unknown
  soc: number | null;
  odometerMi: number | null;
  atHome: boolean | null;
  tempF: number | null;
  cell: string | null;          // salted hash of the ~600 m map cell, never coordinates
}

interface Snapshot {
  ms: number;
  soc: number | null;
  odometerMi: number | null;
  atHome: boolean | null;
  tempF: number | null;
  cell: string | null;
}

export interface DriveState {
  lastParked: Snapshot | null;
  open: { start: Snapshot; lastMs: number } | null;
  skipUntilPark: boolean;       // after a dropped drive, wait for P before starting another
}

export interface DriveRecord {
  start: string;                // ISO
  end: string;                  // ISO
  start_soc: number | null;
  end_soc: number | null;
  miles: number;
  at_home: boolean | null;      // the drive left from home
  end_at_home: boolean | null;  // the drive ended at home
  temp_f: number | null;        // outside temperature at drive start
  start_cell: string | null;
  end_cell: string | null;
}

export type DriveDrop = 'short' | 'gap' | 'no_odometer';

export function initialDriveState(): DriveState {
  return { lastParked: null, open: null, skipUntilPark: false };
}

function snap(p: DrivePoll): Snapshot {
  return { ms: p.ms, soc: p.soc, odometerMi: p.odometerMi, atHome: p.atHome, tempF: p.tempF, cell: p.cell };
}

function round1(x: number): number { return Math.round(x * 10) / 10; }

export function stepDriveLog(
  state: DriveState, poll: DrivePoll,
): { state: DriveState; drive: DriveRecord | null; dropped: DriveDrop | null } {
  const parked = poll.gear === 'park' || (poll.gear === '' && poll.powerState === 'sleep');
  const unknown = poll.gear === '' && !parked;
  if (unknown) return { state, drive: null, dropped: null };

  if (parked) {
    const next: DriveState = { lastParked: snap(poll), open: null, skipUntilPark: false };
    const open = state.open;
    if (!open) return { state: next, drive: null, dropped: null };
    if (poll.ms - open.lastMs > MAX_DRIVE_GAP_MS) return { state: next, drive: null, dropped: 'gap' };
    const s = open.start;
    const miles = s.odometerMi !== null && poll.odometerMi !== null ? poll.odometerMi - s.odometerMi : null;
    if (miles === null) return { state: next, drive: null, dropped: 'no_odometer' };
    if (miles < MIN_DRIVE_MI) return { state: next, drive: null, dropped: 'short' };
    return {
      state: next,
      dropped: null,
      drive: {
        start: new Date(s.ms).toISOString(),
        end: new Date(poll.ms).toISOString(),
        start_soc: s.soc,
        end_soc: poll.soc,
        miles: round1(miles),
        at_home: s.atHome,
        end_at_home: poll.atHome,
        temp_f: s.tempF,
        start_cell: s.cell,
        end_cell: poll.cell,
      },
    };
  }

  // Not in P.
  if (state.skipUntilPark) return { state, drive: null, dropped: null };
  const open = state.open;
  if (open) {
    if (poll.ms - open.lastMs > MAX_DRIVE_GAP_MS) {
      return { state: { lastParked: null, open: null, skipUntilPark: true }, drive: null, dropped: 'gap' };
    }
    return { state: { ...state, open: { start: open.start, lastMs: poll.ms } }, drive: null, dropped: null };
  }
  // A drive can only start from a known parked poll (a restart mid-drive has
  // no trustworthy start).
  const lp = state.lastParked;
  if (!lp) return { state, drive: null, dropped: null };
  const start = poll.ms - lp.ms <= START_BACKFILL_MS ? lp : snap(poll);
  // Temperature and home flag describe the departure; keep the poll's own
  // temperature when the backfilled snapshot has none.
  const merged: Snapshot = { ...start, tempF: start.tempF ?? poll.tempF };
  return { state: { lastParked: null, open: { start: merged, lastMs: poll.ms }, skipUntilPark: false }, drive: null, dropped: null };
}
