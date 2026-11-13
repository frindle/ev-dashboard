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
import { arrivalFloorOf, needEstimate, nextUseDay, sinceHistoryStart, type NeedEstimate, type Shift } from '@/lib/chargePlan';
import { readDailyUse, readDrives } from '@/lib/driveLogStore';
import { liveNeed, type LiveNeed } from '@/lib/needModels';
import { localDate } from '@/lib/rivianDailyUse';
import { KWH_PER_PCT_SEED, measuredKwhPerPct } from '@/lib/kwhPerPct';
import { getShiftCalendar } from '@/lib/shiftCalendar';
import { applyIgnored } from '@/lib/shiftChoices';
import { readIgnored } from '@/lib/shiftChoicesStore';
import { buildRivianPlan, driveTimeTemps, forecastHighFor, forecastTempsFrom, highOnDay, type BuiltPlan, type ForecastTemp, type PlanState } from '@/lib/rivianPlan';
import { loadPeakDays, peakNightsFor } from '@/lib/peakData';
import { pacificFields } from '@/lib/pacificTime';
import type { PeakNightIn } from '@/lib/peakPlan';

export const RIVIAN_MIN_AMPS = 8;   // Rivian app floor (Penn 11-12: lowest it allows is 8A)
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

// Tomorrow's high and the 3-hourly temperatures from OpenWeatherMap's 5-day
// forecast; null when there is no key or the call fails. Called from the write
// slots only, never from tests.
export async function fetchForecast(day: number): Promise<{ highF: number | null; temps: ForecastTemp[] } | null> {
  try {
    const w = readConfig().weather;
    if (!w.apiKey) return null;
    const where = w.lat !== null && w.lon !== null ? `lat=${w.lat}&lon=${w.lon}` : `q=${encodeURIComponent(w.location)}`;
    const res = await fetch(`https://api.openweathermap.org/data/2.5/forecast?${where}&appid=${w.apiKey}&units=imperial`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { list?: Parameters<typeof forecastHighFor>[0] };
    const list = body.list ?? [];
    return { highF: forecastHighFor(list, day), temps: forecastTempsFrom(list) };
  } catch {
    return null;
  }
}

const dayString = (day: number): string => new Date(day * 86_400_000).toISOString().slice(0, 10);

// EV plan #7: the expected use from the daily-use log (the backtest winner),
// or null to keep the charge-history estimate (RIVIAN_NEED_MODEL=history, too
// little daily use, or a read error). Only complete days (before today) count.
async function needFromDailyUse(
  nowMs: number, shifts: Shift[], workDays: Set<number> | null, temps: ForecastTemp[],
): Promise<LiveNeed | null> {
  if (process.env.RIVIAN_NEED_MODEL === 'history') return null;
  try {
    const [rows, drives] = await Promise.all([readDailyUse(), readDrives()]);
    const today = localDate(nowMs);
    const serveDay = nextUseDay(nowMs);
    return liveNeed(
      rows.filter((r) => r.date < today), drives, [...(workDays ?? [])].map(dayString), dayString(serveDay),
      driveTimeTemps(temps, shifts, serveDay),
    );
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
  need7: LiveNeed | null;   // the daily-use need (EV plan #7); null = charge history planned it
  peakNights: PeakNightIn[] | null;   // Rev 18: room under the day peak, serve day + 2; null = off
}

// Rev 18: room under the day peak for the serve day and the two after it, from the NV usage in
// Influx. Off unless RIVIAN_PEAK_PLAN=1: on Penn's NV usage (Feb-Oct 2026) it did not beat the
// plain lowest-amp plan, because past days like the coming one don't say which nights will have
// room. houseSince: the first day of the charge log (nights before it still have the cars in the
// meter's night load).
async function peakNightsNow(
  nowMs: number, workDays: Set<number> | null, forecastHighF: number | null, temps: ForecastTemp[],
  houseSince: string | null,
): Promise<PeakNightIn[] | null> {
  if (process.env.RIVIAN_PEAK_PLAN !== '1') return null;
  const cfg = readConfig();
  const lat = cfg.weather.lat ?? cfg.home.lat;
  const lon = cfg.weather.lon ?? cfg.home.lon;
  const days = await loadPeakDays({ workDays, lat, lon, now: nowMs });
  const serveDay = nextUseDay(nowMs);
  const highs = [0, 1, 2].map((k) => (k === 0 && forecastHighF !== null ? forecastHighF : highOnDay(temps, serveDay + k)));
  const nights = peakNightsFor(days, serveDay, workDays, highs, houseSince);
  // No forecast for any night (no NV usage yet, Influx down): the plain plan, unchanged.
  return nights.some((n) => n.headroomKw.length) ? nights : null;
}

// The serve day's expected use in kWh (no margin, like plannedKwh): from the
// daily-use need when it planned the night, else the charge history.
export function dailyNeedKwhOf(run: RivianPlanRun): number | null {
  const b = run.built;
  if (b && run.need7) return (run.workDays?.has(b.serveDay) ? b.usePctWork : b.usePctOff) * run.kwhPerPct;
  return run.est?.plannedKwh ?? null;
}

// opts.refreshCalendar re-reads the ICS now (the 23:00 slot, an open conflict).
// opts.forecastHighF: a cached high; undefined = none known.
// opts.forecastTemps: cached 3-hourly forecast temperatures (drive-time temps).
export async function rivianNightPlan(
  nowMs: number, opts: { refreshCalendar?: boolean; forecastHighF?: number | null; forecastTemps?: ForecastTemp[] | null } = {},
): Promise<RivianPlanRun> {
  const cfg = readConfig();
  const v = cfg.vehicles.rivian;
  const idFor = vehicleIdResolver(cfg);
  const cal = await getShiftCalendar(nowMs, process.env, undefined, { refresh: !!opts.refreshCalendar });
  const { shifts, workDays } = applyIgnored(cal?.shifts ?? [], cal?.workDays ?? null, await readIgnored());
  const allRows = await readChargeHistory();
  const rows = sinceHistoryStart(allRows.filter((r) => idFor(r) === 'rivian'), v.historySince);
  const firstMs = allRows.reduce((m, r) => { const t = Date.parse(r.startedAt); return Number.isFinite(t) && t < m ? t : m; }, Infinity);
  const houseSince = Number.isFinite(firstMs) ? pacificFields(firstMs).date : null;
  // Measured from the Rivian's own sessions (median of the last 20 that gained
  // >= 10%), seeded with the configured value until there are enough.
  const seed = typeof v.kwhPerPct === 'number' && v.kwhPerPct > 0 ? v.kwhPerPct : KWH_PER_PCT_SEED;
  const kwhPerPct = measuredKwhPerPct(rows, seed);
  const est = needEstimate(rows, workDays, nowMs);
  const state = await readRivianCachedState();
  const floor = arrivalFloorOf(v);
  const forecastHighF = opts.forecastHighF ?? null;
  const need7 = await needFromDailyUse(nowMs, shifts, workDays, opts.forecastTemps ?? []);
  const peakNights = await peakNightsNow(nowMs, workDays, forecastHighF, opts.forecastTemps ?? [], houseSince);
  const built = buildRivianPlan({
    nowMs, est, shifts, workDays, state, kwhPerPct, floorPct: floor.arrivalFloorPct, margin: floor.arrivalDriveMargin,
    forecastHighF, minAmps: RIVIAN_MIN_AMPS, maxAmps: RIVIAN_MAX_AMPS,
    useOverride: need7 ? { work: need7.work, off: need7.off } : null,
    peakNights,
  });
  return { built, est, state, shifts, workDays, timeOffDays: cal?.timeOffDays ?? new Set(), calendar: cal ? { workDays: cal.workDays, shifts: cal.shifts } : null, kwhPerPct, forecastHighF, need7, peakNights };
}
