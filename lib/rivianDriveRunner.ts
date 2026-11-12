// Feeds the Rivian drive log from the dashboard poll (EV charge plan #6).
// Called once per /api/dashboard cycle with the state it just read; never
// throws, and the in-memory machine state is lost on a restart (a drive in
// progress at that moment is simply not logged).
import { readConfig } from '@/lib/config';
import { readChargeHistory } from '@/lib/chargeHistory';
import { vehicleIdResolver } from '@/lib/chargeSessionInflux';
import { sinceHistoryStart } from '@/lib/chargePlan';
import { driveCellSalt, appendDrive, markPollDay, refreshDailyUse } from './driveLogStore.ts';
import { hashCell } from './driveCell.ts';
import { initialDriveState, stepDriveLog, type DriveState } from './rivianDriveLog.ts';
import { localDate } from './rivianDailyUse.ts';

export interface DriveRunnerInput {
  gearStatus?: string;
  powerState?: string;
  chargePercent?: number;
  odometer?: number;
  odometerMiExact?: number | null;
  lat?: number | null;
  lon?: number | null;
}

let state: DriveState = initialDriveState();
let chain: Promise<unknown> = Promise.resolve();

// gps: whether lat/lon are fresh enough to name a cell.
export function recordRivianDrivePoll(
  s: DriveRunnerInput, atHome: boolean | null, tempF: number | null, gpsFresh: boolean, now = Date.now(),
): Promise<void> {
  // Serialized: overlapping dashboard requests must not step the machine out of order.
  const run = chain.then(async () => {
    try {
      await markPollDay(localDate(now));
      let cell: string | null = null;
      if (gpsFresh && typeof s.lat === 'number' && typeof s.lon === 'number') {
        cell = hashCell(await driveCellSalt(), s.lat, s.lon);
      }
      const odo = typeof s.odometerMiExact === 'number' ? s.odometerMiExact
        : typeof s.odometer === 'number' && s.odometer > 0 ? s.odometer : null;
      const out = stepDriveLog(state, {
        ms: now,
        gear: s.gearStatus ?? '',
        powerState: s.powerState,
        soc: typeof s.chargePercent === 'number' ? s.chargePercent : null,
        odometerMi: odo,
        atHome, tempF, cell,
      });
      state = out.state;
      if (out.drive) await appendDrive(out.drive);
    } catch (e) {
      console.error('[drive-log] poll failed:', e instanceof Error ? e.message : e);
    }
  });
  chain = run;
  return run;
}

// Recompute the daily-use rows from the Rivian's charge sessions. Called when
// a charge session ends (the event that closes a between-charges segment).
export async function refreshRivianDailyUse(): Promise<void> {
  try {
    const cfg = readConfig();
    const idFor = vehicleIdResolver(cfg);
    const rows = sinceHistoryStart((await readChargeHistory()).filter((r) => idFor(r) === 'rivian'), cfg.vehicles.rivian.historySince);
    await refreshDailyUse(rows.map((r) => ({
      start: r.startedAt, end: r.endedAt, start_soc: r.startSoc ?? null, end_soc: r.endSoc ?? null,
    })));
  } catch (e) {
    console.error('[drive-log] daily-use refresh failed:', e instanceof Error ? e.message : e);
  }
}
