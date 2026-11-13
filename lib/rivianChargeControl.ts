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
import { arrivalFloorOf, localDayNumber, type NeedEstimate, type TonightPlan } from '@/lib/chargePlan';
import type { LiveNeed } from '@/lib/needModels';
import { recordPlan, recordShiftDays } from '@/lib/planInflux';
import { overridePlan, type OverridePlan } from '@/lib/chargeOverride';
import { readOverride, writeOverride, type StoredOverride } from '@/lib/rivianOverrideStore';
import {
  decideAmps, EV_WINDOW, HOLD_DURATION_MIN, lateStartStep, listInShape, managedIndex, noNeedFits, NO_NEED_ROOM_QUANTILE_INDEX, scheduleWithAmps, writeSlot,
  type AmpsDecision, type Slot,
} from '@/lib/rivianSchedule';
import { fetchRivianChargingSchedules, setRivianChargingSchedules } from '@/lib/rivian';
import { runScorer } from '@/lib/planScoreRun';
import { sendPush } from '@/lib/pushover';
import { writeFailureReason } from '@/lib/rivianWriteError';
import { arrivalPlugAlert, planAlerts, plugDecision, pruneSent } from '@/lib/planAlerts';
import { readPlanStore, writePlanStore, type PlanStore } from '@/lib/planAlertStore';
import { dailyNeedKwhOf, fetchForecast, rivianNightPlan, serveNightForecast, RIVIAN_MAX_AMPS, RIVIAN_MIN_AMPS, type RivianPlanRun } from '@/lib/rivianNightPlan';
import type { NightPlan } from '@/lib/chargePlan';
import { planNights } from '@/lib/peakPlan';
import { packKwhFor, RIVIAN_PACK_KWH_DEFAULT } from '@/lib/packKwh';
import type { ForecastTemp } from '@/lib/rivianPlan';
import { runTripLayer } from '@/lib/tripRun';
import type { Alert } from '@/lib/planAlerts';

const RUN_INTERVAL_MS = 15 * 60_000;

export interface RivianChargeStatus {
  atMs: number;
  dailyNeedKwh: number | null;   // the plan's need (work-day raise included)
  need: NeedEstimate | null;
  need7: LiveNeed | null;        // EV plan #7 daily-use need; null = charge history planned it
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
  hold: boolean;          // the car is (or this run wrote it) on the one-minute hold
  noNeed: { roomKw: number | null; hold: boolean } | null;   // no-need night: p30 room and the choice
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

const ROOM_RETRY_MS = 2 * 3_600_000;

// The serve night's room under the forecast peak, fetched once per serve day (an unknown room is
// retried after 2 h) and kept in the plan store so Influx is not read every 15 minutes.
async function serveRoomFor(
  store: PlanStore, run: RivianPlanRun, serveDay: number, now: number, temps: ForecastTemp[],
): Promise<NonNullable<PlanStore['serveRoom']>> {
  const c = store.serveRoom;
  if (c && c.day === serveDay && (c.headroomKw.length > 0 || now - c.atMs < ROOM_RETRY_MS)) return c;
  const n = await serveNightForecast(now, serveDay, run.workDays, run.forecastHighF, temps, run.houseSince);
  return (store.serveRoom = { day: serveDay, atMs: now, aimKw: n.aimKw, houseKw: n.houseKw, headroomKw: n.headroomKw });
}

async function runOnce(now: number, arrived = false): Promise<RivianChargeStatus> {
  const status: RivianChargeStatus = {
    atMs: now, dailyNeedKwh: null, need: null, need7: null, daily: null, night: null, conflict: false, slot: null,
    override: null, overridePlan: null, controlEnabled: process.env.RIVIAN_SCHEDULE_CONTROL === '1',
    car: null, decision: null, wrote: null, hold: false, noNeed: null, pluggedIn: null, kwhPerPct: null, error: null,
  };
  try {
    const today = localDayNumber(now);
    const hour = new Date(now).getHours();
    const store: PlanStore = await readPlanStore();
    store.sent = pruneSent(store.sent, now);
    const slot = writeSlot(now, store.done);
    status.slot = slot;

    // The forecast (high + 3-hourly temps) is fetched once in a slot, then reused until it is for another day.
    const serveDay = localDayNumber(now + (hour < 8 ? 0 : 24) * 3_600_000);
    if (slot !== null && store.forecast?.day !== serveDay) {
      const f = await fetchForecast(serveDay);
      if (f && (f.highF !== null || f.temps.length)) store.forecast = { day: serveDay, highF: f.highF, temps: f.temps };
    }
    const forecastHighF = store.forecast?.day === serveDay ? store.forecast.highF : null;
    const forecastTemps = store.forecast?.day === serveDay ? store.forecast.temps ?? [] : [];
    const refreshCalendar = slot === 'update' || (store.conflictOpenDay !== null && hour < 8);
    const run = await rivianNightPlan(now, { refreshCalendar, forecastHighF, forecastTemps });
    if (run.calendar) void recordShiftDays(run.calendar.workDays, today, process.env, undefined, { shifts: run.calendar.shifts, timeOffDays: run.timeOffDays });
    const built = run.built;
    const plan = built?.result.plan ?? null;
    status.need = run.est;
    status.need7 = run.need7;
    status.dailyNeedKwh = dailyNeedKwhOf(run);
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

    // What the plan expects for the serve day, for scoring it tomorrow (lib/planScoreRun.ts).
    if (slot !== null && built) {
      const kwh = dailyNeedKwhOf(run);
      if (kwh !== null && run.kwhPerPct > 0) {
        const room = await serveRoomFor(store, run, built.serveDay, now, forecastTemps);
        store.planned[built.serveDay] = {
          pct: kwh / run.kwhPerPct, kwh, aimKw: room.aimKw, houseKw: room.houseKw, roomKw: room.headroomKw[2] ?? null,
        };
        for (const k of Object.keys(store.planned)) if (Number(k) < built.serveDay - 60) delete store.planned[k];
      }
    }

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
      // The planned start only exists in the car when writing is on; with it off
      // the car keeps its own schedule, so "not charging yet" is no problem.
      notChargingPush = status.controlEnabled && step.notChargingPush;
    }
    // A conflict that was open and is now fixed may raise tonight's amps (never lower them).
    const fixed = store.conflictOpenDay !== null && !status.conflict;
    const fixRaiseAmps = fixed && (hour >= 23 || hour < 8) ? plan?.amps ?? null : null;

    // Pushes (the missed-write ones only mean something with writing on).
    const lastEnd = run.shifts.filter((s) => s.day === today).reduce<number | null>((m, s) => (m === null || s.endMs > m ? s.endMs : m), null);
    const ov = activeOverride ? { targetPct: activeOverride.targetPct, byMs: activeOverride.byMs } : null;
    // Rev 18: the plug-in call reruns the demand planner from the car's real SoC (the plan itself
    // started from an estimate before 23:00); its required morning replaces reach + buffer.
    const realSoc = run.state?.chargePercent;
    const peakNow = built?.result.peakInput && typeof realSoc === 'number' && realSoc > 0
      ? planNights({ ...built.result.peakInput, socPct: realSoc }) : null;
    const plug = plugDecision({
      socPct: realSoc ?? null,
      reachPct: peakNow ? peakNow.requiredPct[0] : plan?.reachPct ?? null,
      bufferPct: peakNow ? 0 : plan?.bufferPct ?? 0,
      override: ov,
      peakCharge: peakNow ? peakNow.amps[0] !== null : null,
    });
    // Plug-in rule: on a no-need night the car charges (8A) only if 8A fits under the forecast
    // daily peak; otherwise the schedule is held. Needs writing on, and the room is read once a day.
    let holdNight = false;
    let noNeedFits_ = false;
    if (status.controlEnabled && plug.needed === false && built) {
      const room = await serveRoomFor(store, run, built.serveDay, now, forecastTemps);
      const rejected = store.holdRejectedServe === built.serveDay;
      noNeedFits_ = rejected || noNeedFits(room.headroomKw, RIVIAN_MIN_AMPS);
      holdNight = !noNeedFits_;
      status.noNeed = { roomKw: room.headroomKw[NO_NEED_ROOM_QUANTILE_INDEX] ?? null, hold: holdNight };
    }
    // A hold night is not charging on purpose.
    if (holdNight) notChargingPush = false;
    const alerts = planAlerts({
      nowMs: now, today,
      done: status.controlEnabled ? store.done : { forecast: today, update: today },
      sent: new Set(Object.keys(store.sent)),
      conflictDay: status.conflict && built ? built.serveDay : null,
      conflictWasOpenDay: store.conflictOpenDay,
      shortfall: plan?.shortfall ?? false,
      atHome: atHomeOf(run), plugged: run.state?.isPluggedIn ?? null,
      lastShiftEndMs: lastEnd, isOffDay: !!run.workDays && !run.workDays.has(today),
      needsCharge: !!plan && plan.amps !== null && (plan.peak ? plan.peak.charge : plan.totalPct > 0),
      plugNeeded: plug.needed,
      limitPct: run.state?.chargeLimit ?? null, notChargingPush,
      serveDay: built?.serveDay ?? today, dashboardUrl: process.env.DASHBOARD_URL ?? null,
    });
    // Arrival home (the dashboard poll sees the car approach): plug in or not, once after a shift.
    const arrival = arrived ? arrivalPlugAlert({
      nowMs: now, today, sent: new Set(Object.keys(store.sent)), shiftEndsMs: run.shifts.map((s) => s.endMs),
      socPct: run.state?.chargePercent ?? null, decision: plug, override: ov,
      amps: plan?.amps ?? null, raiseLimitTo: plan?.raiseLimitTo ?? null,
      noNeed: status.noNeed ? (status.noNeed.hold ? 'hold' : 'charge') : null,
    }) : null;
    for (const a of [...alerts, ...(arrival ? [arrival] : []), ...(trips?.alerts ?? [])] as Alert[]) {
      if (await sendPush(a.title, a.message, a.priority, a.link)) store.sent[a.key] = now;
    }
    store.conflictOpenDay = status.conflict && built ? built.serveDay : null;

    // Once a day after 08:00: score the last served day against the plan (never throws).
    const cfg = readConfig();
    await runScorer(now, store, {
      workDays: run.workDays, floorPct: arrivalFloorOf(cfg.vehicles.rivian).arrivalFloorPct,
      lat: cfg.weather.lat ?? cfg.home.lat, lon: cfg.weather.lon ?? cfg.home.lon,
    });

    if (!status.controlEnabled) { await writePlanStore(store); return status; }

    // A failed write: the reason (already scrubbed of coordinates) goes to status, the log and
    // Influx; one push a day.
    const writeFailed = async (error: string) => {
      status.error = error;
      console.error(`[rivian-charge] write failed: ${error}`);
      const key = `write-failed:${today}`;
      if (!store.sent[key] && await sendPush('Rivian schedule write failed', error, 0)) store.sent[key] = now;
    };
    const list = await fetchRivianChargingSchedules();
    if (!list) {
      status.error = 'Rivian not connected or backing off';
      await writePlanStore(store);
      return status;
    }
    const i = managedIndex(list);
    const cur = i >= 0 ? list[i] : null;
    if (cur) {
      status.car = { amperage: cur.amperage, startTime: cur.startTime, duration: cur.duration, enabled: cur.enabled };
      status.hold = cur.duration === HOLD_DURATION_MIN;
    }
    const op = status.overridePlan;
    status.decision = decideAmps({
      nowMs: now, current: cur, slot,
      dailyAmps: plan?.amps ?? null,
      overrideAmps: op && op.windows > 0 ? op.amps : null,
      replanAmps, fixRaiseAmps, inShape: listInShape(list),
      noNeed: status.noNeed ? { fits: noNeedFits_, minAmps: RIVIAN_MIN_AMPS } : undefined,
    });
    const amps = status.decision.amps;
    const holdIt = !!status.decision.hold;
    const next = amps === null ? null : scheduleWithAmps(list, amps, holdIt);
    let slotSettled = false;
    if (amps !== null && next) {
      let res = await setRivianChargingSchedules(next);
      let held = holdIt;
      if (!res.ok && holdIt) {
        // Rivian refused the one-minute hold: record why, then charge 8A tonight instead.
        await writeFailed(res.error);
        if (built) store.holdRejectedServe = built.serveDay;
        const fallback = scheduleWithAmps(list, amps, false);
        console.log(`[rivian-charge] hold rejected, falling back to the ${amps}A charge window`);
        held = false;
        if (fallback) res = await setRivianChargingSchedules(fallback);
      }
      if (!res.ok) await writeFailed(res.error);
      else {
        status.wrote = amps;
        status.hold = held;
        status.car = { amperage: amps, startTime: EV_WINDOW.startMin, duration: held ? HOLD_DURATION_MIN : EV_WINDOW.durationMin, enabled: true };
        slotSettled = true;
        if (status.decision.reason === 'late-start replan' && built) store.replanned = built.serveDay;
        console.log(held
          ? `[rivian-charge] schedule held: ${amps}A for 1 minute at 00:00 every day, no charge tonight (${status.decision.reason})`
          : `[rivian-charge] schedule set to ${amps}A 00:00-08:00 every day (${status.decision.reason})`);
      }
    } else if (slot !== null && cur) {
      // up to date, or nothing to write for this window (0 usable hours)
      slotSettled = status.decision.reason === 'up to date' || (plan !== null && plan.amps === null);
    }
    if (slot !== null && slotSettled) store.done = { ...store.done, [slot]: today };
    await writePlanStore(store);
  } catch (e) {
    status.error = writeFailureReason(e);
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
    decided_amps: s.decision?.amps, hold: s.noNeed || s.hold ? s.hold : undefined, no_need: s.noNeed ? true : undefined, no_need_room_kw: s.noNeed?.roomKw ?? undefined, control_error: s.error ?? undefined, car_amps: s.car?.amperage, wrote_amps: s.wrote, control_enabled: s.controlEnabled,
    peak_charge: n?.peak?.charge, peak_aim_kw: n?.peak?.aimKw ?? undefined, peak_house_kw: n?.peak?.houseKw ?? undefined,
    peak_headroom_kw: n?.peak?.headroomKw ?? undefined, peak_over_kw: n?.peak?.overKw, peak_cost_usd: n?.peak?.costUsd,
    peak_horizon_usd: n?.peak?.horizonUsd,
  };
}

let last: RivianChargeStatus | null = null;
let lastRunMs = 0;
let inFlight: Promise<RivianChargeStatus> | null = null;

// Resolves to the latest status (a fresh run when due or forced).
export async function runRivianChargeControl(opts: { force?: boolean; arrived?: boolean } = {}): Promise<RivianChargeStatus | null> {
  if (inFlight) {
    if (!opts.force) return inFlight;
    await inFlight.catch(() => {});
    if (inFlight) return inFlight;
  }
  const now = Date.now();
  if (!opts.force && last && now - lastRunMs < RUN_INTERVAL_MS) return last;
  lastRunMs = now;
  inFlight = runOnce(now, !!opts.arrived).then((s) => { last = s; void recordPlan('rivian', planFields(s), s.atMs); return s; }).finally(() => { inFlight = null; });
  return inFlight;
}
