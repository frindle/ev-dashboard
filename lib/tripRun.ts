// The trip layer's runner (EV charge plan #8): reads the personal calendar,
// places and routes the events, plans each of the next 7 days with
// lib/tripPlan.ts, and hands back an automatic "N% by departure" override, the
// pushes to send and the Influx points. Inert unless PERSONAL_CAL_URL is set:
// then nothing is fetched and null comes back, so the plan is unchanged.
//
// A manual override always wins (the caller only uses `override` when there is
// no stored one). No event title, place or coordinate reaches a push, a log
// line or Influx; the /trips page (LAN-only) is the one place places show.
import { readConfig } from '@/lib/config';
import { dayTimeMs, DEPART_BUFFER_MIN, localDayNumber, plannedFor } from '@/lib/chargePlan';
import { overridePlan, validOverride, OVERRIDE_MIN_PCT, type ChargeOverride } from '@/lib/chargeOverride';
import { influxTarget, writeLines } from '@/lib/chargeSessionInflux';
import type { Alert } from '@/lib/planAlerts';
import { packKwhFor, RIVIAN_PACK_KWH_DEFAULT } from '@/lib/packKwh';
import { getShiftCalendar } from '@/lib/shiftCalendar';
import { driveCellSalt, readDrives } from '@/lib/driveLogStore';
import { placeEvent, WORK_KEY, searchPlaces } from '@/lib/geocode';
import type { LatLon } from '@/lib/ics';
import { eventsWithin, getPersonalEvents, personalCalendarOn, TRIP_DAYS_AHEAD, type PersonalEvent } from '@/lib/personalCalendar';
import { EV_WINDOW } from '@/lib/rivianSchedule';
import { dailyNeedKwhOf, fetchForecast, RIVIAN_MAX_AMPS, RIVIAN_MIN_AMPS, type RivianPlanRun } from '@/lib/rivianNightPlan';
import { tripAlerts, type TripSummary } from '@/lib/tripAlerts';
import { tripPlanLine } from '@/lib/tripInflux';
import { adjustForTrip, ALL_DAY_START_HOUR, awayDays, manualAdjust, pctForMiles, planTripDay, type Adjusted, type RouteFn, type TripDay, type TripEvent } from '@/lib/tripPlan';
import { mutateTripChoices, readGeoOverrides, readTripChoices, type ManualNeed } from '@/lib/tripStore';
import { cellOf, fileRouteCache, legTraffic, readTrafficProfile, routeLeg } from '@/lib/valhalla';

export interface EventView {
  uid: string;
  startMs: number;
  allDay: boolean;
  multiDay: boolean;
  location: string;
  placed: boolean;
  tag: 'home' | 'straight' | null;       // the notes tag
  toggle: 'home' | 'straight' | null;     // the /trips toggle
  overlap: boolean;                       // overlaps the shift
  choice: 'skip' | 'going' | 'fix' | null;
}

export interface DayView {
  day: number;
  dateLabel: string;
  isWork: boolean;
  away: boolean;                          // inside a multi-day trip
  events: EventView[];
  plan: TripDay | null;
  adj: Adjusted | null;
  baseNeedPct: number;
  highF: number | null;
  manual: ManualNeed | null;              // the day's need typed on /trips: replaces the trip estimate
  byMs: number | null;                    // when the car must be ready (the plan's departure, else a default for a typed need)
}

export interface TripLayer {
  days: DayView[];
  workKnown: boolean;
  override: ChargeOverride | null;        // the automatic "N% by departure" target
  summaries: TripSummary[];
}

const highCache = new Map<number, { highF: number | null; atMs: number }>();
async function highFor(day: number, nowMs: number): Promise<number | null> {
  const c = highCache.get(day);
  if (c && nowMs - c.atMs < 3 * 3_600_000) return c.highF;
  const highF = (await fetchForecast(day))?.highF ?? null;
  highCache.set(day, { highF, atMs: nowMs });
  return highF;
}

const routeCache = fileRouteCache();

async function placeWork(nowMs: number): Promise<LatLon | null> {
  const picked = (await readGeoOverrides())[WORK_KEY];
  if (picked) return picked;
  const wp = (await getShiftCalendar(nowMs))?.workPlace ?? null;
  if (!wp) return null;
  if (wp.geo) return wp.geo;
  const [h] = wp.location ? await searchPlaces(wp.location, process.env, undefined, 1, nowMs) : [];
  return h ? { lat: h.lat, lon: h.lon } : null;
}

// Everything the planner and the /trips page show, for the next 7 days.
export async function computeTrips(run: RivianPlanRun, nowMs: number, opts: { refresh?: boolean } = {}): Promise<TripLayer | null> {
  if (!personalCalendarOn()) return null;
  const all = await getPersonalEvents(nowMs, process.env, undefined, { refresh: opts.refresh });
  const home = readConfig().home;
  if (!all || home.lat === null || home.lon === null) return null;
  const homePt: LatLon = { lat: home.lat, lon: home.lon };
  const within = eventsWithin(all, nowMs);
  const overrides = await readGeoOverrides();
  const { choices, toggles, needs } = await readTripChoices();
  const work = await placeWork(nowMs);
  await routeCache.load();
  const salt = await driveCellSalt();
  const drives = await readDrives();
  const profile = await readTrafficProfile();
  const route: RouteFn = async (a, b, atMs) => {
    const leg = await routeLeg(a, b, { cache: routeCache, salt });
    if (!leg) return null;
    const t = legTraffic({ baseSeconds: leg.seconds, departMs: atMs, fromCell: cellOf(salt, a), toCell: cellOf(salt, b), drives, hourOfWeek: profile });
    return { miles: leg.miles, seconds: t.seconds };
  };
  const away = awayDays(within, localDayNumber);
  const today = localDayNumber(nowMs);
  const days: DayView[] = [];
  for (let day = today; day <= today + TRIP_DAYS_AHEAD; day++) {
    const dayEvents = within.filter((e: PersonalEvent) => e.day === day);
    const shifts = run.shifts.filter((s) => s.day === day);
    const shift = shifts.length ? { startMs: Math.min(...shifts.map((s) => s.startMs)), endMs: Math.max(...shifts.map((s) => s.endMs)) } : null;
    const isWork = !!shift;
    const isAway = away.has(day);
    const tripEvents: TripEvent[] = [];
    const views: EventView[] = [];
    for (const e of dayEvents) {
      const placed = await placeEvent(e, overrides);
      tripEvents.push({ uid: e.uid, startMs: e.startMs, endMs: e.endMs, allDay: e.allDay, multiDay: e.multiDay, tag: e.tag, point: placed ? { lat: placed.lat, lon: placed.lon } : null });
      views.push({
        uid: e.uid, startMs: e.startMs, allDay: e.allDay, multiDay: e.multiDay, location: e.location, placed: !!placed, tag: e.tag,
        toggle: toggles[`${e.uid}@${day}`] ?? null, overlap: !!shift && !e.allDay && e.startMs < shift.endMs && Math.max(e.endMs, e.startMs) > shift.startMs,
        choice: choices[`${e.uid}@${day}`] ?? null,
      });
    }
    const kwhPerPct = run.kwhPerPct > 0 ? run.kwhPerPct : 1.44;
    // The same expected use the night plan uses: the daily-use need (#7) when it
    // has one for this kind of day, else the charge history, else 20% / 10%.
    const n7 = isWork ? run.need7?.work : run.need7?.off;
    const baseNeedPct = typeof n7 === 'number' && Number.isFinite(n7) ? n7
      : run.est ? plannedFor(run.est, isWork) / kwhPerPct : (isWork ? 20 : 10);
    let plan: TripDay | null = null;
    let adj: Adjusted | null = null;
    let highF: number | null = null;
    if (dayEvents.length && !isAway) {
      plan = await planTripDay({
        day, localMs: (h) => dayTimeMs(day, h), home: homePt, homeRadiusM: Math.max(100, home.radiusMeters ?? 150),
        shift, work, events: tripEvents, choices, toggles, route,
      });
      if (plan && !plan.unroutable && plan.miles > 0) {
        highF = await highFor(day, nowMs);
        adj = adjustForTrip({ isWork, baseNeedPct, miles: plan.miles, extraMiles: plan.extraMiles, highF });
      }
    }
    // A need typed on /trips wins over the trip estimate (and covers a place
    // that cannot be found or a route that cannot be worked out).
    const manual = needs[String(day)] ?? null;
    if (manual) {
      highF = highF ?? await highFor(day, nowMs);
      adj = manualAdjust({ baseNeedPct, pct: manual.unit === 'mi' ? pctForMiles(manual.value, highF) : manual.value });
    }
    const timed = dayEvents.filter((e) => !e.allDay).map((e) => e.startMs);
    const byMs = plan?.departMs ?? (manual
      ? (shift ? shift.startMs - DEPART_BUFFER_MIN * 60_000 : timed.length ? Math.min(...timed) - 3_600_000 : dayTimeMs(day, ALL_DAY_START_HOUR))
      : null);
    days.push({ day, dateLabel: new Date(dayTimeMs(day, 12)).toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' }), isWork, away: isAway, events: views, plan, adj, baseNeedPct, highF, manual, byMs });
  }

  // The summaries behind pushes, and the soonest raising trip as the override.
  const state = run.state;
  const packKwh = packKwhFor(state?.batteryCapacityKwh, readConfig().vehicles.rivian.packKwh, RIVIAN_PACK_KWH_DEFAULT);
  let override: ChargeOverride | null = null;
  const summaries: TripSummary[] = [];
  for (const d of days) {
    if (!d.plan && !d.manual) continue;
    const raise = !!d.adj?.raise && d.byMs !== null && (!!d.manual || !d.plan?.needsWork);
    let reachable: boolean | null = null;
    let ov: ChargeOverride | null = null;
    if (raise && d.adj && d.byMs !== null) {
      ov = validOverride({ targetPct: Math.max(OVERRIDE_MIN_PCT, Math.min(100, Math.round(d.adj.targetPct))), byMs: d.byMs }, nowMs);
      if (ov) {
        const op = overridePlan({
          override: ov, nowMs, socPct: state?.chargePercent, limitPct: state?.chargeLimit, packKwh,
          dailyKwh: dailyNeedKwhOf(run) ?? 0, window: EV_WINDOW, minAmps: RIVIAN_MIN_AMPS, maxAmps: RIVIAN_MAX_AMPS,
        });
        reachable = op ? op.feasible : null;
        if (!override) override = ov;
      }
    }
    summaries.push({
      day: d.day, dateLabel: d.dateLabel, miles: d.plan?.miles ?? 0, needPct: d.adj?.needPct ?? 0, targetPct: d.adj?.targetPct ?? 0,
      byMs: d.byMs, raise: raise && !!ov, multiDay: d.plan?.multiDay ?? false, unplaced: d.plan?.unplaced.length ?? 0,
      unroutable: !!d.plan?.unroutable, manual: !!d.manual,
      overlaps: d.plan?.overlaps.length ?? 0, limitPct: state?.chargeLimit ?? null, reachable,
    });
  }
  return { days, workKnown: !!work, override, summaries };
}

// One run: plan, write the Influx points, decide the pushes. `sent` are the
// alert keys already sent; the caller sends the alerts and records their keys.
export async function runTripLayer(
  run: RivianPlanRun, nowMs: number, p: { sent: Set<string>; slot: 'forecast' | 'update' | null; serveDay: number; refresh?: boolean },
): Promise<{ layer: TripLayer; alerts: Alert[] } | null> {
  try {
    const layer = await computeTrips(run, nowMs, { refresh: p.refresh });
    if (!layer) return null;
    const choices = await readTripChoices();
    const alerts = tripAlerts({
      nowMs, today: localDayNumber(nowMs), serveDay: p.serveDay, sent: p.sent, days: layer.summaries,
      openBefore: choices.openDays, dashboardUrl: process.env.DASHBOARD_URL ?? null, slot: p.slot,
    });
    const open = layer.summaries.filter((s) => s.overlaps > 0).map((s) => s.day);
    if (open.join() !== choices.openDays.join()) await mutateTripChoices((c) => { c.openDays = open; });
    const target = influxTarget();
    const lines = layer.days.filter((d) => d.plan && d.adj).map((d) => tripPlanLine({
      day: d.day, miles: d.plan!.miles, pct: d.adj!.needPct, target: d.adj!.targetPct, byMs: d.plan!.departMs,
    }));
    if (target && lines.length) await writeLines(lines, target, undefined, 10_000).catch(() => 0);
    return { layer, alerts };
  } catch (e) {
    console.error('[trips] run failed:', (e instanceof Error ? e.name : 'error'));
    return null;
  }
}
