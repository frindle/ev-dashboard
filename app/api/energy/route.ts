// Backs the two bottom-row dashboard tiles: the 7-day charge-history
// sparkline and the fuel-savings comparison. Both read the same
// charge-history.jsonl rows, so they share one route rather than two.

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { readConfig } from '@/lib/config';
import { readChargeHistory, type ChargeHistoryRow } from '@/lib/chargeHistory';
import {
  COMPARABLES,
  RATE_SCHEDULE_LABEL,
  sessionElectricityCostUsd,
  type VehicleId,
} from '@/lib/rates';
import { GAS_PRICE_LABEL, fetchGasPriceUsdPerGallon } from '@/lib/gasPrice';
import { arrivalFloorOf, needEstimate, sinceHistoryStart, tonightPlan } from '@/lib/chargePlan';
import { rivianNightPlan } from '@/lib/rivianNightPlan';
import { packKwhFor } from '@/lib/packKwh';

export const dynamic = 'force-dynamic';

const SPARK_DAYS = 7;

export interface EnergyVehicleSummary {
  id: VehicleId;
  name: string;
  dailyKwh: number[];          // aligned to EnergySummary.days
  comparable: string;          // e.g. "2026 Mazda 3 4-Door 2WD 2.5L"
  mpg: number;
  miPerKwh: number | null;     // null when we have no usable live state
  // Running average kWh charged/day over up to the trailing 6 months. A
  // TRUE running average, not a fixed 182-day divisor: while a vehicle has
  // less than 6 months of charge-history rows, divides by the actual span
  // since its earliest recorded session instead -- otherwise a car with 3
  // weeks of data would read at ~1/8th its real daily average until the
  // window fills up. null only when there's no charge history at all yet.
  avgDailyKwh6mo: number | null;
  // What the car uses per day now: EWMA (7-day half-life) of daily use, with
  // each session spread over the days since the previous one. This is the
  // number to cover every night. See lib/chargePlan.ts for the backtest.
  // null until the car has sessions on two different days.
  dailyNeedKwh: number | null;
  // What tonight's plan covers: dailyNeedKwh, raised to the recent work-day
  // rate when the coming day is a shift on the work calendar (Rivian only;
  // SHIFTS_ICS_URL). Never below dailyNeedKwh.
  plannedNeedKwh: number | null;
  nextDayWork: boolean | null;   // null without a calendar
  workKwh: number | null;        // recent kWh/day on work days / off days
  offKwh: number | null;
  // Wall kWh to refill the live gap below the charge limit (cached state,
  // ~10% charging loss included); null if SoC/limit unknown.
  gapKwh: number | null;
  // Wall kWh tonight that gets home at the vehicle's arrival floor (config
  // arrivalFloorPct, after arrivalDriveMargin x plannedNeedKwh of driving);
  // null if the vehicle has no floor or SoC/limit is unknown.
  floorKwh: number | null;
  // Tonight's 8h plan: planned need plus half of any gap beyond it, at least
  // floorKwh, in 2A steps (min 8A Rivian / 5A Tesla, max 48A). null when
  // dailyNeedKwh is.
  tonightKwh: number | null;
  tonightAmps: number | null;
  // Rivian night plan (lib/rivianPlan.ts), null for the Tesla: hours the charge
  // can use tonight and on the next night, the short-night buffer (% of
  // battery), shift conflict, can't-reach flag, and the trip hook (#8, not built).
  windowHours: number | null;
  nextWindowHours: number | null;
  bufferPct: number | null;
  conflict: boolean | null;
  shortfall: boolean | null;
  trip: null;
}

// Charger-current bounds for tonightAmps. 5A is the Tesla's lowest setting;
// 8A is the lowest the Rivian app allows (Penn 11-12). 48A is the Wall Connector's maximum.
const MIN_AMPS: Record<VehicleId, number> = { rivian: 8, tesla: 5 };
const MAX_AMPS = 48;

export interface EnergySessionSummary {
  vehicleName: string;
  endedAt: string;
  kwh: number;
  electricityUsd: number;
  gasEquivalentUsd: number | null;
  savedUsd: number | null;
}

export interface EnergySummary {
  days: string[];              // local YYYY-MM-DD, oldest → newest
  vehicles: EnergyVehicleSummary[];
  rateLabel: string;
  gasPriceLabel: string;
  gasPriceUsdPerGallon: number | null;
  gasPricePeriod: string | null;
  monthLabel: string;          // local YYYY-MM the savings total covers
  monthKwh: number;
  monthElectricityUsd: number;
  monthGasEquivalentUsd: number | null;
  monthSavedUsd: number | null;
  lastSession: EnergySessionSummary | null;
}

function localDateStr(d: Date): string {
  return d.toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
}

/**
 * Rated efficiency (mi/kWh) from state the app already caches: the vehicle's
 * remaining range over the energy actually sitting in the pack. Reuses the
 * same per-poll state snapshots the dashboard route writes, rather than
 * inventing a separate efficiency assumption or a new telemetry field.
 * Returns null when the cache is missing or the numbers are implausible.
 *
 * APPROXIMATIONS — this is an estimate tile, not a billing figure:
 *  1. packKwh in COMPARABLES is a hardcoded *nominal* pack size that assumes a
 *     specific trim (R1S 124.5, Model 3 Long Range 82). A Standard-pack
 *     car would make this read low — e.g. a 60 kWh Model 3 RWD comes out ~27%
 *     under — and the sanity band below is far too wide to catch that. If
 *     either vehicle is ever swapped, update COMPARABLES.
 *  2. rangeMi is EPA *rated* range, so this is rated efficiency, not observed.
 *  3. The caller multiplies this by wall-connector kWh, which is AC energy
 *     measured before charging losses (~10% on L2), while this ratio is
 *     pack-side. That overstates miles added; using nominal rather than usable
 *     capacity in (1) understates it by a similar amount, so the two roughly
 *     cancel — but neither is modelled on purpose.
 */
interface CachedState { rangeMi?: number; chargePercent?: number; chargeLimit?: number; batteryCapacityKwh?: number | null }

async function readCachedState(cacheFile: string): Promise<CachedState | null> {
  const dir = process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
  const path = join(dir, cacheFile);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8')) as { state?: CachedState };
    return raw.state ?? null;
  } catch {
    return null;
  }
}

function ratedMiPerKwh(state: CachedState | null, packKwh: number): number | null {
  const range = state?.rangeMi ?? 0;
  const soc = state?.chargePercent ?? 0;
  if (!(range > 0) || !(soc > 5)) return null;   // <5% SOC makes the ratio noisy
  const eff = range / (packKwh * (soc / 100));
  return eff > 0.5 && eff < 6 ? eff : null;      // sanity band for a road EV
}

export async function GET() {
  const cfg = readConfig();

  // charge-history rows only carry a vehicleName, so map that back to the
  // vehicle id the comparable-MPG table is keyed on. Falls back to the
  // charger side, which is also recorded on every row, if a vehicle was
  // renamed in config after the rows were written.
  const nameToId = new Map<string, VehicleId>([
    [cfg.vehicles.rivian.name, 'rivian'],
    [cfg.vehicles.tesla.name, 'tesla'],
  ]);
  const sideToId = new Map<'LEFT' | 'RIGHT', VehicleId>([
    [cfg.vehicles.rivian.chargerSide, 'rivian'],
    [cfg.vehicles.tesla.chargerSide, 'tesla'],
  ]);
  const idFor = (r: ChargeHistoryRow): VehicleId => nameToId.get(r.vehicleName) ?? sideToId.get(r.side) ?? 'tesla';

  const rows = await readChargeHistory();

  // ── 7-day sparkline ──
  const days: string[] = [];
  for (let i = SPARK_DAYS - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(localDateStr(d));
  }
  const dayIndex = new Map(days.map((d, i) => [d, i]));

  const daily: Record<VehicleId, number[]> = {
    rivian: new Array(SPARK_DAYS).fill(0),
    tesla: new Array(SPARK_DAYS).fill(0),
  };
  for (const r of rows) {
    const t = new Date(r.startedAt);
    const i = dayIndex.get(localDateStr(t));
    if (i === undefined) continue;
    daily[idFor(r)][i] += r.energyKwh;
  }

  const [rivianState, teslaState, gas] = await Promise.all([
    readCachedState('rivian-state.json'),
    readCachedState('tesla-state.json'),
    fetchGasPriceUsdPerGallon(),
  ]);
  const stateFor: Record<VehicleId, CachedState | null> = { rivian: rivianState, tesla: teslaState };
  // Live batteryCapacity when the car reports it, else the configured packKwh,
  // else the comparables table (lib/packKwh.ts).
  const packFor: Record<VehicleId, number> = {
    rivian: packKwhFor(rivianState?.batteryCapacityKwh, cfg.vehicles.rivian.packKwh, COMPARABLES.rivian.packKwh),
    tesla: packKwhFor(null, cfg.vehicles.tesla.packKwh, COMPARABLES.tesla.packKwh),
  };
  const effFor: Record<VehicleId, number | null> = {
    rivian: ratedMiPerKwh(rivianState, packFor.rivian),
    tesla: ratedMiPerKwh(teslaState, packFor.tesla),
  };

  // ── running 6-month daily average ──
  const SIX_MONTHS_MS = 182 * 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const sixMoCutoff = nowMs - SIX_MONTHS_MS;
  const earliestMs: Record<VehicleId, number> = { rivian: Infinity, tesla: Infinity };
  const sixMoKwh: Record<VehicleId, number> = { rivian: 0, tesla: 0 };
  for (const r of rows) {
    const id = idFor(r);
    const t = new Date(r.startedAt).getTime();
    if (t < earliestMs[id]) earliestMs[id] = t;
    if (t >= sixMoCutoff) sixMoKwh[id] += r.energyKwh;
  }
  const avgDailyKwh6moFor: Record<VehicleId, number | null> = { rivian: null, tesla: null };
  for (const id of ['rivian', 'tesla'] as const) {
    if (!isFinite(earliestMs[id])) continue; // no charge history at all yet
    const windowStartMs = Math.max(earliestMs[id], sixMoCutoff);
    const windowDays = Math.max(1, (nowMs - windowStartMs) / (24 * 60 * 60 * 1000));
    avgDailyKwh6moFor[id] = Math.round((sixMoKwh[id] / windowDays) * 100) / 100;
  }

  const round2 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);
  // The shift calendar is the Rivian's: the backtest that chose it was the
  // Rivian's history (lib/chargePlan.ts).
  // The Rivian plan is the shared night plan (lib/rivianNightPlan.ts): same
  // numbers the schedule writer uses. Its history starts at historySince (the
  // current Rivian only); the sparkline and savings below keep every row.
  const rivianRun = await rivianNightPlan(nowMs);
  const rv = rivianRun.built?.result ?? null;
  const vehicles: EnergyVehicleSummary[] = (['rivian', 'tesla'] as const).map(id => {
    const est = id === 'rivian'
      ? rivianRun.est
      : needEstimate(sinceHistoryStart(rows.filter(r => idFor(r) === id), cfg.vehicles.tesla.historySince), null, nowMs);
    const plan = id === 'rivian' || est === null ? null : tonightPlan({
      dailyKwh: est.plannedKwh,
      socPct: stateFor[id]?.chargePercent,
      limitPct: stateFor[id]?.chargeLimit,
      packKwh: packFor[id],
      minAmps: MIN_AMPS[id],
      maxAmps: MAX_AMPS,
      ...arrivalFloorOf(cfg.vehicles[id]),
    });
    return {
      id,
      name: cfg.vehicles[id].name,
      dailyKwh: daily[id].map(k => Math.round(k * 100) / 100),
      comparable: COMPARABLES[id].comparable,
      mpg: COMPARABLES[id].mpg,
      miPerKwh: round2(effFor[id]),
      avgDailyKwh6mo: avgDailyKwh6moFor[id],
      dailyNeedKwh: round2(est?.ewmaKwh ?? null),
      plannedNeedKwh: round2(est?.plannedKwh ?? null),
      nextDayWork: est?.nextDayWork ?? null,
      workKwh: round2(est?.rates?.workKwh ?? null),
      offKwh: round2(est?.rates?.offKwh ?? null),
      gapKwh: round2(id === 'rivian'
        ? (rv?.plan.gapPct == null ? null : rv.plan.gapPct * rivianRun.kwhPerPct) : plan?.gapKwh ?? null),
      floorKwh: round2(plan?.floorKwh ?? null),
      tonightKwh: round2(id === 'rivian' ? rv?.plan.kwh ?? null : plan?.tonightKwh ?? null),
      tonightAmps: id === 'rivian' ? rv?.plan.amps ?? null : plan?.tonightAmps ?? null,
      windowHours: id === 'rivian' ? rv?.plan.windowHours ?? null : null,
      nextWindowHours: id === 'rivian' ? rv?.plan.nextWindowHours ?? null : null,
      bufferPct: id === 'rivian' ? round2(rv?.plan.bufferPct ?? null) : null,
      conflict: id === 'rivian' ? rv?.conflict ?? null : null,
      shortfall: id === 'rivian' ? rv?.plan.shortfall ?? null : null,
      trip: null,   // the drive-log trip hook (#8) is not built yet
    };
  });

  // ── Savings, per session then totalled for the current calendar month ──
  // savings = (equivalent gas cost for the same miles) − (actual TOU electricity cost)
  function priceSession(r: ChargeHistoryRow): EnergySessionSummary {
    const id = idFor(r);
    const startMs = new Date(r.startedAt).getTime();
    const endMs = new Date(r.endedAt).getTime();
    const electricityUsd = sessionElectricityCostUsd(startMs, endMs, r.energyKwh);
    const eff = effFor[id];
    // Miles this charge actually added, then what the comparable gas car
    // would have burned covering them.
    const gasEquivalentUsd = eff !== null && gas
      ? (r.energyKwh * eff / COMPARABLES[id].mpg) * gas.usdPerGallon
      : null;
    return {
      vehicleName: r.vehicleName,
      endedAt: r.endedAt,
      kwh: Math.round(r.energyKwh * 100) / 100,
      electricityUsd: Math.round(electricityUsd * 100) / 100,
      gasEquivalentUsd: gasEquivalentUsd === null ? null : Math.round(gasEquivalentUsd * 100) / 100,
      savedUsd: gasEquivalentUsd === null ? null : Math.round((gasEquivalentUsd - electricityUsd) * 100) / 100,
    };
  }

  const monthLabel = localDateStr(new Date()).slice(0, 7);
  let monthKwh = 0, monthElectricityUsd = 0, monthGasEquivalentUsd = 0;
  let anyGasPriced = false;
  for (const r of rows) {
    if (localDateStr(new Date(r.startedAt)).slice(0, 7) !== monthLabel) continue;
    const p = priceSession(r);
    monthKwh += r.energyKwh;
    monthElectricityUsd += p.electricityUsd;
    if (p.gasEquivalentUsd !== null) { monthGasEquivalentUsd += p.gasEquivalentUsd; anyGasPriced = true; }
  }

  const latest = rows.reduce<ChargeHistoryRow | null>(
    (best, r) => (!best || r.endedAt > best.endedAt ? r : best), null);

  const summary: EnergySummary = {
    days,
    vehicles,
    rateLabel: RATE_SCHEDULE_LABEL,
    gasPriceLabel: GAS_PRICE_LABEL,
    gasPriceUsdPerGallon: gas?.usdPerGallon ?? null,
    gasPricePeriod: gas?.period ?? null,
    monthLabel,
    monthKwh: Math.round(monthKwh * 10) / 10,
    monthElectricityUsd: Math.round(monthElectricityUsd * 100) / 100,
    monthGasEquivalentUsd: anyGasPriced ? Math.round(monthGasEquivalentUsd * 100) / 100 : null,
    monthSavedUsd: anyGasPriced ? Math.round((monthGasEquivalentUsd - monthElectricityUsd) * 100) / 100 : null,
    lastSession: latest ? priceSession(latest) : null,
  };

  return Response.json(summary);
}
