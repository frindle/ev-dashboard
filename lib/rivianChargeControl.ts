// Applies the Rivian charge plan to the car's charging schedule.
//
// Each run: the daily plan (EWMA need + catch-up, chargePlan.ts) and the
// one-off override (chargeOverride.ts) give the amps for the 00:00-08:00
// window, and setChargingSchedules is called when the car's schedule differs
// (rules in rivianSchedule.ts). Writing is off unless
// RIVIAN_SCHEDULE_CONTROL=1. A Pushover heads-up goes out once per override
// when it needs a higher charge limit (the account session can't change the
// limit: that is a sendVehicleCommand, which must be signed by an enrolled
// phone key) or can't be reached by the deadline.
//
// Driven by the /api/dashboard poll (every 30s from instrumentation.ts),
// throttled to RUN_INTERVAL_MS; override changes force a run. Never throws.
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { readConfig } from '@/lib/config';
import { readChargeHistory } from '@/lib/chargeHistory';
import { vehicleIdResolver } from '@/lib/chargeSessionInflux';
import { ewmaDailyKwh, tonightPlan, type TonightPlan } from '@/lib/chargePlan';
import { overridePlan, type OverridePlan } from '@/lib/chargeOverride';
import { readOverride, writeOverride, type StoredOverride } from '@/lib/rivianOverrideStore';
import { decideAmps, EV_WINDOW, managedIndex, scheduleWithAmps, type AmpsDecision } from '@/lib/rivianSchedule';
import { fetchRivianChargingSchedules, setRivianChargingSchedules } from '@/lib/rivian';
import { sendPush } from '@/lib/pushover';

const PACK_KWH = 135;   // COMPARABLES.rivian.packKwh in app/api/energy/route.ts
const MIN_AMPS = 6;
const MAX_AMPS = 48;
const RUN_INTERVAL_MS = 15 * 60_000;

export interface RivianChargeStatus {
  atMs: number;
  dailyNeedKwh: number | null;
  daily: TonightPlan | null;
  override: StoredOverride | null;
  overridePlan: OverridePlan | null;
  controlEnabled: boolean;
  car: { amperage: number; startTime: number; duration: number; enabled: boolean } | null;
  decision: AmpsDecision | null;
  wrote: number | null;   // amps written this run
  error: string | null;
}

async function readCachedRivianState(): Promise<{ chargePercent?: number; chargeLimit?: number } | null> {
  const path = join(process.env.KEYS_DIR ?? join(process.cwd(), 'keys'), 'rivian-state.json');
  if (!existsSync(path)) return null;
  try {
    return (JSON.parse(await readFile(path, 'utf-8')) as { state?: { chargePercent?: number; chargeLimit?: number } }).state ?? null;
  } catch {
    return null;
  }
}

async function maybeNudge(o: StoredOverride | null, plan: OverridePlan | null): Promise<void> {
  if (!o || !plan || o.nudgedAtMs) return;
  const parts: string[] = [];
  if (plan.raiseLimitTo !== null) parts.push(`Raise the charge limit to ${plan.raiseLimitTo}% in the Rivian app.`);
  if (!plan.feasible) {
    parts.push(plan.windows
      ? `Only about ${Math.floor(plan.reachablePct)}% is reachable at ${MAX_AMPS}A in the midnight-8am window before then.`
      : 'There is no midnight-8am charge window before then.');
  }
  if (!parts.length) return;
  const by = new Date(o.byMs).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  if (await sendPush('Rivian charge override', `${o.targetPct}% by ${by}. ${parts.join(' ')}`)) {
    await writeOverride({ ...o, nudgedAtMs: Date.now() });
  }
}

async function runOnce(now: number): Promise<RivianChargeStatus> {
  const status: RivianChargeStatus = {
    atMs: now, dailyNeedKwh: null, daily: null, override: null, overridePlan: null,
    controlEnabled: process.env.RIVIAN_SCHEDULE_CONTROL === '1', car: null, decision: null, wrote: null, error: null,
  };
  try {
    const idFor = vehicleIdResolver(readConfig());
    const need = ewmaDailyKwh((await readChargeHistory()).filter((r) => idFor(r) === 'rivian'));
    const st = await readCachedRivianState();
    const common = { socPct: st?.chargePercent, limitPct: st?.chargeLimit, packKwh: PACK_KWH, minAmps: MIN_AMPS, maxAmps: MAX_AMPS };
    status.dailyNeedKwh = need;
    status.daily = need === null ? null : tonightPlan({ ...common, dailyKwh: need });
    status.override = await readOverride(now);
    status.overridePlan = status.override
      ? overridePlan({ ...common, override: status.override, nowMs: now, dailyKwh: need ?? 0, window: EV_WINDOW })
      : null;
    await maybeNudge(status.override, status.overridePlan);
    if (!status.controlEnabled) return status;

    const list = await fetchRivianChargingSchedules();
    if (!list) {
      status.error = 'Rivian not connected or backing off';
      return status;
    }
    const i = managedIndex(list);
    const cur = i >= 0 ? list[i] : null;
    if (cur) status.car = { amperage: cur.amperage, startTime: cur.startTime, duration: cur.duration, enabled: cur.enabled };
    const op = status.overridePlan;
    status.decision = decideAmps({
      nowMs: now,
      current: cur,
      dailyAmps: status.daily?.tonightAmps ?? null,
      overrideAmps: op && op.windows > 0 ? op.amps : null,
    });
    const amps = status.decision.amps;
    const next = amps === null ? null : scheduleWithAmps(list, amps);
    if (amps !== null && next) {
      if (await setRivianChargingSchedules(next)) {
        status.wrote = amps;
        status.car = { amperage: amps, startTime: EV_WINDOW.startMin, duration: EV_WINDOW.durationMin, enabled: true };
        console.log(`[rivian-charge] schedule set to ${amps}A 00:00-08:00 (${status.decision.reason})`);
      } else {
        status.error = 'setChargingSchedules did not report success';
      }
    }
  } catch (e) {
    status.error = String(e instanceof Error ? e.message : e).slice(0, 200);
    console.error('[rivian-charge]', status.error);
  }
  return status;
}

let last: RivianChargeStatus | null = null;
let lastRunMs = 0;
let inFlight: Promise<RivianChargeStatus> | null = null;

// Resolves to the latest status (a fresh run when due or forced).
export async function runRivianChargeControl(opts: { force?: boolean } = {}): Promise<RivianChargeStatus | null> {
  if (inFlight) {
    if (!opts.force) return inFlight;
    await inFlight.catch(() => {});
    if (inFlight) return inFlight;
  }
  const now = Date.now();
  if (!opts.force && last && now - lastRunMs < RUN_INTERVAL_MS) return last;
  lastRunMs = now;
  inFlight = runOnce(now).then((s) => { last = s; return s; }).finally(() => { inFlight = null; });
  return inFlight;
}
