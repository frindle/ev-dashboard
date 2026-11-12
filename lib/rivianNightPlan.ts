// Gathers what the Rivian night plan needs (config, Midknight's history, the
// shift calendar minus the shifts Penn ignored, the cached car state, the
// forecast high) and runs lib/rivianPlan.ts. Shared by the schedule writer
// (lib/rivianChargeControl.ts) and /api/energy so both show the same plan.
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { readConfig } from '@/lib/config';
import { readChargeHistory } from '@/lib/chargeHistory';
import { vehicleIdResolver } from '@/lib/chargeSessionInflux';
import { arrivalFloorOf, needEstimate, sinceHistoryStart, type NeedEstimate, type Shift } from '@/lib/chargePlan';
import { KWH_PER_PCT_SEED, measuredKwhPerPct } from '@/lib/kwhPerPct';
import { getShiftCalendar } from '@/lib/shiftCalendar';
import { applyIgnored } from '@/lib/shiftChoices';
import { readIgnored } from '@/lib/shiftChoicesStore';
import { buildRivianPlan, forecastHighFor, type BuiltPlan, type PlanState } from '@/lib/rivianPlan';

export const RIVIAN_MIN_AMPS = 6;
export const RIVIAN_MAX_AMPS = 48;

export interface RivianCachedState extends PlanState {
  lat?: number | null;
  lon?: number | null;
  isCharging?: boolean | null;
  batteryCapacityKwh?: number | null;
}

export async function readRivianCachedState(): Promise<RivianCachedState | null> {
  const path = join(process.env.KEYS_DIR ?? join(process.cwd(), 'keys'), 'rivian-state.json');
  if (!existsSync(path)) return null;
  try {
    return (JSON.parse(await readFile(path, 'utf-8')) as { state?: RivianCachedState }).state ?? null;
  } catch {
    return null;
  }
}

// Tomorrow's high from OpenWeatherMap's 5-day forecast; null when there is no
// key or the call fails. Called from the write slots only, never from tests.
export async function fetchForecastHigh(day: number): Promise<number | null> {
  try {
    const w = readConfig().weather;
    if (!w.apiKey) return null;
    const where = w.lat !== null && w.lon !== null ? `lat=${w.lat}&lon=${w.lon}` : `q=${encodeURIComponent(w.location)}`;
    const res = await fetch(`https://api.openweathermap.org/data/2.5/forecast?${where}&appid=${w.apiKey}&units=imperial`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { list?: Parameters<typeof forecastHighFor>[0] };
    return forecastHighFor(body.list ?? [], day);
  } catch {
    return null;
  }
}

export interface RivianPlanRun {
  built: BuiltPlan | null;
  est: NeedEstimate | null;
  state: RivianCachedState | null;
  shifts: Shift[];
  workDays: Set<number> | null;
  timeOffDays: Set<number>;
  calendar: { workDays: Set<number>; shifts: Shift[] } | null;   // as read, before ignored shifts (for Influx)
  kwhPerPct: number;
  forecastHighF: number | null;
}

// opts.refreshCalendar re-reads the ICS now (the 23:00 slot, an open conflict).
// opts.forecastHighF: a cached high; undefined = none known.
export async function rivianNightPlan(
  nowMs: number, opts: { refreshCalendar?: boolean; forecastHighF?: number | null } = {},
): Promise<RivianPlanRun> {
  const cfg = readConfig();
  const v = cfg.vehicles.rivian;
  const idFor = vehicleIdResolver(cfg);
  const cal = await getShiftCalendar(nowMs, process.env, undefined, { refresh: !!opts.refreshCalendar });
  const { shifts, workDays } = applyIgnored(cal?.shifts ?? [], cal?.workDays ?? null, await readIgnored());
  const rows = sinceHistoryStart((await readChargeHistory()).filter((r) => idFor(r) === 'rivian'), v.historySince);
  // Measured from the Rivian's own sessions (median of the last 20 that gained
  // >= 10%), seeded with the configured value until there are enough.
  const seed = typeof v.kwhPerPct === 'number' && v.kwhPerPct > 0 ? v.kwhPerPct : KWH_PER_PCT_SEED;
  const kwhPerPct = measuredKwhPerPct(rows, seed);
  const est = needEstimate(rows, workDays, nowMs);
  const state = await readRivianCachedState();
  const floor = arrivalFloorOf(v);
  const forecastHighF = opts.forecastHighF ?? null;
  const built = buildRivianPlan({
    nowMs, est, shifts, workDays, state, kwhPerPct, floorPct: floor.arrivalFloorPct, margin: floor.arrivalDriveMargin,
    forecastHighF, minAmps: RIVIAN_MIN_AMPS, maxAmps: RIVIAN_MAX_AMPS,
  });
  return { built, est, state, shifts, workDays, timeOffDays: cal?.timeOffDays ?? new Set(), calendar: cal ? { workDays: cal.workDays, shifts: cal.shifts } : null, kwhPerPct, forecastHighF };
}
