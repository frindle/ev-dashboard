// The Tesla's tonight plan, as /api/energy shows it, kept pure so the peak cap can use the same numbers.
// (Moved out of app/api/energy/route.ts; no change in what the route returns.)
import {
  arrivalFloorOf, KW_PER_AMP, needEstimate, sinceHistoryStart, tonightPlan,
  type NeedEstimate, type TonightPlan,
} from './chargePlan.ts';

// Charger-current bounds: 5A is the Tesla's lowest setting; 48A is the Wall Connector's maximum.
export const TESLA_MIN_AMPS = 5;
export const TESLA_MAX_AMPS = 48;

export interface TeslaPlanState { chargePercent?: number; chargeLimit?: number; isPluggedIn?: boolean }
export interface TeslaPlanInput {
  rows: Parameters<typeof needEstimate>[0];   // the Tesla's charge-history rows
  vehicle: { historySince?: string | null; arrivalFloorPct?: unknown; arrivalDriveMargin?: unknown } | null | undefined;
  state: TeslaPlanState | null | undefined;
  packKwh: number;
  nowMs: number;
}
export interface TeslaPlanRun { est: NeedEstimate | null; plan: TonightPlan | null }

export function teslaPlanRun(p: TeslaPlanInput): TeslaPlanRun {
  const est = needEstimate(sinceHistoryStart(p.rows, p.vehicle?.historySince ?? null), null, p.nowMs);
  const plan = est === null ? null : tonightPlan({
    dailyKwh: est.plannedKwh,
    socPct: p.state?.chargePercent,
    limitPct: p.state?.chargeLimit,
    packKwh: p.packKwh,
    minAmps: TESLA_MIN_AMPS,
    maxAmps: TESLA_MAX_AMPS,
    ...arrivalFloorOf(p.vehicle),
  });
  return { est, plan };
}

/** The Tesla's planned kW tonight on the shared circuit: amps x volts; 0 when unplugged, no plan or no charge. */
export function teslaPlannedKw(run: TeslaPlanRun, state: TeslaPlanState | null | undefined): number {
  if (!state || state.isPluggedIn !== true) return 0;
  const amps = run.plan?.tonightAmps;
  if (typeof amps !== 'number' || !Number.isFinite(amps) || amps <= 0 || !(run.plan!.tonightKwh > 0)) return 0;
  return amps * KW_PER_AMP;
}
