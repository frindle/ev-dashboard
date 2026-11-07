// Records each car's live state in InfluxDB as ev_vehicle_state, so there is
// SoC / charge-limit / odometer history for both cars (Telegraf's
// ev_vehicle scrape of /api/dashboard/cached only ever stored at_home and
// power_kw_parallax: its json_v2 parse fails on state_chargeLimit and
// power_kw_parallax has a bool/float type conflict).
//
// Point: ev_vehicle_state,vehicle=rivian|tesla soc=..,charge_limit=..,odometer=..,
//        range_mi=..,plugged_in=0|1,charging=0|1,online=0|1,at_home=0|1 <ms>
// Every field is a float (booleans as 0/1) so a field's type can never
// conflict. No coordinates are written.
//
// Called on every /api/dashboard poll; writes a car at most every
// STATE_INTERVAL_MS, or right away when plugged_in/charging changes.
import { influxTarget, writeLines } from './chargeSessionInflux.ts';

export const STATE_MEASUREMENT = 'ev_vehicle_state';
export const STATE_INTERVAL_MS = 5 * 60_000;
const STATE_TIMEOUT_MS = 5_000;

export interface VehicleStateInput {
  id: string;
  atHome?: boolean | null;
  state: {
    chargePercent?: number;
    chargeLimit?: number;
    odometer?: number;
    rangeMi?: number;
    isPluggedIn?: boolean;
    isCharging?: boolean;
    online?: boolean;
  } | null;
}

type FetchLike = Parameters<typeof writeLines>[2];

const POSITIVE: [string, keyof NonNullable<VehicleStateInput['state']>][] = [
  ['soc', 'chargePercent'], ['charge_limit', 'chargeLimit'], ['odometer', 'odometer'],
];
const FLAGS: [string, keyof NonNullable<VehicleStateInput['state']>][] = [
  ['plugged_in', 'isPluggedIn'], ['charging', 'isCharging'], ['online', 'online'],
];

// null when the car is unknown or nothing usable is in its state. 0 is
// treated as "not reported" for soc, charge_limit and odometer.
export function vehicleStateLine(v: VehicleStateInput, ms: number): string | null {
  if (!v || (v.id !== 'rivian' && v.id !== 'tesla') || !v.state) return null;
  const s = v.state;
  const fields: string[] = [];
  for (const [name, key] of POSITIVE) {
    const x = s[key];
    if (typeof x === 'number' && Number.isFinite(x) && x > 0) fields.push(`${name}=${x}`);
  }
  if (typeof s.rangeMi === 'number' && Number.isFinite(s.rangeMi) && s.rangeMi >= 0) fields.push(`range_mi=${s.rangeMi}`);
  for (const [name, key] of FLAGS) {
    const x = s[key];
    if (typeof x === 'boolean') fields.push(`${name}=${x ? 1 : 0}`);
  }
  if (typeof v.atHome === 'boolean') fields.push(`at_home=${v.atHome ? 1 : 0}`);
  if (!fields.length) return null;
  return `${STATE_MEASUREMENT},vehicle=${v.id} ${fields.join(',')} ${Math.round(ms)}`;
}

function changeKey(v: VehicleStateInput): string {
  return `${v.state?.isPluggedIn}|${v.state?.isCharging}`;
}

// One recorder per process. record() never throws and returns how many
// lines it wrote. A failed write is retried on the next poll.
export function createVehicleStateRecorder(intervalMs = STATE_INTERVAL_MS) {
  const last = new Map<string, { ms: number; key: string }>();
  let inFlight = false;
  return async function record(
    vehicles: VehicleStateInput[],
    now = Date.now(),
    env: Record<string, string | undefined> = process.env,
    fetchImpl?: FetchLike,
  ): Promise<number> {
    if (inFlight) return 0;
    try {
      const target = influxTarget(env);
      if (!target) return 0;
      const due: { id: string; key: string; line: string }[] = [];
      for (const v of vehicles ?? []) {
        const line = vehicleStateLine(v, now);
        if (!line) continue;
        const key = changeKey(v);
        const prev = last.get(v.id);
        if (prev && now - prev.ms < intervalMs && prev.key === key) continue;
        due.push({ id: v.id, key, line });
      }
      if (!due.length) return 0;
      inFlight = true;
      await writeLines(due.map((d) => d.line), target, fetchImpl, STATE_TIMEOUT_MS);
      for (const d of due) last.set(d.id, { ms: now, key: d.key });
      return due.length;
    } catch (e) {
      console.error('[vehicle-state] influx write failed:', e instanceof Error ? e.message : e);
      return 0;
    } finally {
      inFlight = false;
    }
  };
}

export const recordVehicleState = createVehicleStateRecorder();
