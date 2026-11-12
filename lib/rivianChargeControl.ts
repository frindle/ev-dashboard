// Applies the Rivian charge plan to the car's charging schedule.
//
// The plan (lib/rivianPlan.ts: shift-aware night window, battery %, short-night
// buffer, heat cap) and the one-off override (chargeOverride.ts) give the amps
// for the 00:00-08:00 window. The daily plan is written in two slots: a
// forecast from 08:15 and an update from 23:00 (rivianSchedule.ts writeSlot);
// an override still writes right away, and inside the window only a raise is
// allowed (override, late-start replan, a fixed shift conflict). Writing is
// off unless RIVIAN_SCHEDULE_CONTROL=1: nothing is written to the car without
// it. Pushover alerts (lib/planAlerts.ts) go out once each. A heads-up also
// goes out once per override when it needs a higher charge limit (the account
// session can't change the limit: that is a sendVehicleCommand, which must be
// signed by an enrolled phone key) or can't be reached by the deadline.
//
// Driven by the /api/dashboard poll (every 30s from instrumentation.ts),
// throttled to RUN_INTERVAL_MS; override changes force a run. Never throws.
import { readConfig } from '@/lib/config';
import { localDayNumber, type NeedEstimate, type TonightPlan } from '@/lib/chargePlan';
import { recordPlan, recordShiftDays } from '@/lib/planInflux';
import { overridePlan, type OverridePlan } from '@/lib/chargeOverride';
import { readOverride, writeOverride, type StoredOverride } from '@/lib/rivianOverrideStore';
import {
  decideAmps, EV_WINDOW, lateStartStep, managedIndex, scheduleWithAmps, writeSlot,
  type AmpsDecision, type Slot,
} from '@/lib/rivianSchedule';
import { fetchRivianChargingSchedules, setRivianChargingSchedules } from '@/lib/rivian';
import { sendPush } from '@/lib/pushover';
import { planAlerts, pruneSent } from '@/lib/planAlerts';
import { readPlanStore, writePlanStore, type PlanStore } from '@/lib/planAlertStore';
import { fetchForecastHigh, rivianNightPlan, RIVIAN_MAX_AMPS, RIVIAN_MIN_AMPS, type RivianPlanRun } from '@/lib/rivianNightPlan';
import type { NightPlan } from '@/lib/chargePlan';
import { packKwhFor, RIVIAN_PACK_KWH_DEFAULT } from '@/lib/packKwh';
import { runTripLayer } from '@/lib/tripRun';
import type { Alert } from '@/lib/planAlerts';

const RUN_INTERVAL_MS = 15 * 60_000;

export interface RivianChargeStatus {
  atMs: number;
  dailyNeedKwh: number | null;   // the plan's need (work-day raise included)
  need: NeedEstimate | null;
  daily: TonightPlan | null;     // tonight's kWh and amps, in the shape the UI reads
  night: NightPlan | null;       // the full night plan (window hours, buffer, shortfall...)
  conflict: boolean;
  slot: Slot | null;
  override: StoredOverride | null;
  overridePlan: OverridePlan | null;
  controlEnabled: boolean;
  car: { amperage: number; startTime: number; duration: number; enabled: boolean } | null;
  decision: AmpsDecision | null;
  wrote: number | null;   // amps written this run
  pluggedIn: boolean | null;
  kwhPerPct: number | null;
  error: string | null;
}

async function maybeNudge(o: StoredOverride | null, plan: OverridePlan | null): Promise<void> {
  if (!o || !plan || o.nudgedAtMs) return;
  const parts: string[] = [];
  if (plan.raiseLimitTo !== null) parts.push(`Raise the charge limit to ${plan.raiseLimitTo}% in the Rivian app.`);
  if (!plan.feasible) {
    parts.push(plan.windows
      ? `Only about ${Math.floor(plan.reachablePct)}% is reachable at ${RIVIAN_MAX_AMPS}A in the midnight-8am window before then.`
      : 'There is no midnight-8am charge window before then.');
  }
  if (!parts.length) return;
  const by = new Date(o.byMs).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  if (await sendPush('Rivian charge override', `${o.targetPct}% by ${by}. ${parts.join(' ')}`)) {
    await writeOverride({ ...o, nudgedAtMs: Date.now() });
  }
}

function metersBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371000;
  const p1 = aLat * Math.PI / 180, p2 = bLat * Math.PI / 180;
  const dp = (bLat - aLat) * Math.PI / 180, dl = (bLon - aLon) * Math.PI / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// null when the car's position or home is unknown.
function atHomeOf(run: RivianPlanRun): boolean | null {
  const home = readConfig().home;
  const { lat, lon } = run.state ?? {};
  if (home.lat === null || home.lon === null || typeof lat !== 'number' || typeof lon !== 'number') return null;
  return metersBetween(lat, lon, home.lat, home.lon) <= home.radiusMeters;
}

async function runOnce(now: number): Promise<RivianChargeStatus> {
  const status: RivianChargeStatus = {
    atMs: now, dailyNeedKwh: null, need: null, daily: null, night: null, conflict: false, slot: null,
    override: null, overridePlan: null, controlEnabled: process.env.RIVIAN_SCHEDULE_CONTROL === '1',
    car: null, decision: null, wrote: null, pluggedIn: null, kwhPerPct: null, error: null,
  };
  try {
    const today = localDayNumber(now);
    const hour = new Date(now).getHours();
    const store: PlanStore = await readPlanStore();
    store.sent = pruneSent(store.sent, now);
    const slot = writeSlot(now, store.done);
    status.slot = slot;

    // The forecast high is fetched once in a slot, then reused until it is for another day.
    const serveDay = localDayNumber(now + (hour < 8 ? 0 : 24) * 3_600_000);
    if (slot !== null && store.forecast?.day !== serveDay) {
      const highF = await fetchForecastHigh(serveDay);
      if (highF !== null) store.forecast = { day: serveDay, highF };
    }
    const forecastHighF = store.forecast?.day === serveDay ? store.forecast.highF : null;
    const refreshCalendar = slot === 'update' || (store.conflictOpenDay !== null && hour < 8);
    const run = await rivianNightPlan(now, { refreshCalendar, forecastHighF });
    if (run.calendar) void recordShiftDays(run.calendar.workDays, today, process.env, undefined, { shifts: run.calendar.shifts, timeOffDays: run.timeOffDays });
    const built = run.built;
    const plan = built?.result.plan ?? null;
    status.need = run.est;
    status.dailyNeedKwh = run.est?.plannedKwh ?? null;
    status.night = plan;
    status.conflict = built?.result.conflict ?? false;
    status.pluggedIn = run.state?.isPluggedIn ?? null;
    status.kwhPerPct = run.kwhPerPct;
    if (plan && plan.amps !== null) {
      status.daily = {
        gapKwh: plan.gapPct === null ? null : plan.gapPct * run.kwhPerPct, floorKwh: null,
        tonightKwh: plan.kwh, tonightAmps: plan.amps,
      };
    }
    if (slot !== null && plan?.targetPct != null && built) store.target = { day: built.serveDay, pct: plan.targetPct };

    status.override = await readOverride(now);
    // Personal-calendar trips (#8): inert unless PERSONAL_CAL_URL is set. Its
    // automatic "N% by departure" target is used only when no manual override is stored.
    const trips = await runTripLayer(run, now, { sent: new Set(Object.keys(store.sent)), slot, serveDay, refresh: slot === 'update' });
    const activeOverride = status.override ?? trips?.layer.override ?? null;
    status.overridePlan = activeOverride
      ? overridePlan({
        socPct: run.state?.chargePercent, limitPct: run.state?.chargeLimit, packKwh: packKwhFor(run.state?.batteryCapacityKwh, readConfig().vehicles.rivian.packKwh, RIVIAN_PACK_KWH_DEFAULT),
        minAmps: RIVIAN_MIN_AMPS, maxAmps: RIVIAN_MAX_AMPS, override: activeOverride, nowMs: now,
        dailyKwh: status.dailyNeedKwh ?? 0, window: EV_WINDOW,
      })
      : null;
    await maybeNudge(status.override, status.overridePlan);

    // Late start: not charging by the planned start + 15 min, charging later.
    let replanAmps: number | null = null;
    let notChargingPush = false;
    if (built && hour < 8) {
      const w = built.result.window;
      const step = lateStartStep({
        nowMs: now, windowStartMs: w.startMs, windowEndMs: w.endMs, charging: !!run.state?.isCharging,
        lateSeen: store.lateSeen === built.serveDay, replanned: store.replanned === built.serveDay,
        targetPct: store.target?.day === built.serveDay ? store.target.pct : null,
        socPct: run.state?.chargePercent ?? null, kwhPerPct: run.kwhPerPct, minAmps: RIVIAN_MIN_AMPS, maxAmps: RIVIAN_MAX_AMPS,
      });
      if (step.lateSeen) store.lateSeen = built.serveDay;
      replanAmps = step.replanAmps;
      notChargingPush = step.notChargingPush;
    }
    // A conflict that was open and is now fixed may raise tonight's amps (never lower them).
    const fixed = store.conflictOpenDay !== null && !status.conflict;
    const fixRaiseAmps = fixed && (hour >= 23 || hour < 8) ? plan?.amps ?? null : null;

    // Pushes (the missed-write ones only mean something with writing on).
    const lastEnd = run.shifts.filter((s) => s.day === today).reduce<number | null>((m, s) => (m === null || s.endMs > m ? s.endMs : m), null);
    const alerts = planAlerts({
      nowMs: now, today,
      done: status.controlEnabled ? store.done : { forecast: today, update: today },
      sent: new Set(Object.keys(store.sent)),
      conflictDay: status.conflict && built ? built.serveDay : null,
      conflictWasOpenDay: store.conflictOpenDay,
      shortfall: plan?.shortfall ?? false,
      atHome: atHomeOf(run), plugged: run.state?.isPluggedIn ?? null,
      lastShiftEndMs: lastEnd, isOffDay: !!run.workDays && !run.workDays.has(today),
      needsCharge: !!plan && plan.amps !== null && plan.totalPct > 0,
      limitPct: run.state?.chargeLimit ?? null, notChargingPush,
      serveDay: built?.serveDay ?? today, dashboardUrl: process.env.DASHBOARD_URL ?? null,
    });
    for (const a of [...alerts, ...(trips?.alerts ?? [])] as Alert[]) {
      if (await sendPush(a.title, a.message, a.priority, a.link)) store.sent[a.key] = now;
    }
    store.conflictOpenDay = status.conflict && built ? built.serveDay : null;

    if (!status.controlEnabled) { await writePlanStore(store); return status; }

    const list = await fetchRivianChargingSchedules();
    if (!list) {
      status.error = 'Rivian not connected or backing off';
      await writePlanStore(store);
      return status;
    }
    const i = managedIndex(list);
    const cur = i >= 0 ? list[i] : null;
    if (cur) status.car = { amperage: cur.amperage, startTime: cur.startTime, duration: cur.duration, enabled: cur.enabled };
    const op = status.overridePlan;
    status.decision = decideAmps({
      nowMs: now, current: cur, slot,
      dailyAmps: plan?.amps ?? null,
      overrideAmps: op && op.windows > 0 ? op.amps : null,
      replanAmps, fixRaiseAmps,
    });
    const amps = status.decision.amps;
    const next = amps === null ? null : scheduleWithAmps(list, amps);
    let slotSettled = false;
    if (amps !== null && next) {
      if (await setRivianChargingSchedules(next)) {
        status.wrote = amps;
        status.car = { amperage: amps, startTime: EV_WINDOW.startMin, duration: EV_WINDOW.durationMin, enabled: true };
        slotSettled = true;
        if (status.decision.reason === 'late-start replan' && built) store.replanned = built.serveDay;
        console.log(`[rivian-charge] schedule set to ${amps}A 00:00-08:00 (${status.decision.reason})`);
      } else {
        status.error = 'setChargingSchedules did not report success';
      }
    } else if (slot !== null && cur) {
      // up to date, or nothing to write for this window (0 usable hours)
      slotSettled = status.decision.reason === 'up to date' || (plan !== null && plan.amps === null);
    }
    if (slot !== null && slotSettled) store.done = { ...store.done, [slot]: today };
    await writePlanStore(store);
  } catch (e) {
    status.error = String(e instanceof Error ? e.message : e).slice(0, 200);
    console.error('[rivian-charge]', status.error);
  }
  return status;
}

// Plan history for scoring it later (lib/planInflux.ts).
function planFields(s: RivianChargeStatus) {
  const n = s.night;
  return {
    ewma_kwh: s.need?.ewmaKwh, planned_kwh: s.need?.plannedKwh, work_kwh: s.need?.rates?.workKwh, off_kwh: s.need?.rates?.offKwh,
    next_day_work: s.need?.nextDayWork ?? undefined, gap_kwh: s.daily?.gapKwh, floor_kwh: s.daily?.floorKwh,
    tonight_kwh: s.daily?.tonightKwh, tonight_amps: s.daily?.tonightAmps,
    window_hours: n?.windowHours, next_window_hours: n?.nextWindowHours ?? undefined, buffer_pct: n?.bufferPct,
    kwh_per_pct: s.kwhPerPct ?? undefined, plugged_in: s.pluggedIn ?? undefined,
    slot: s.slot === 'forecast' ? 1 : s.slot === 'update' ? 2 : undefined,
    override_target_pct: s.override?.targetPct, override_amps: s.overridePlan?.amps,
    decided_amps: s.decision?.amps, car_amps: s.car?.amperage, wrote_amps: s.wrote, control_enabled: s.controlEnabled,
  };
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
  inFlight = runOnce(now).then((s) => { last = s; void recordPlan('rivian', planFields(s), s.atMs); return s; }).finally(() => { inFlight = null; });
  return inFlight;
}
