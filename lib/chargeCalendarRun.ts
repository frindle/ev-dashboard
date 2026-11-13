// Server-side assembly for the /charging page and the Nextcloud forecast calendar: the controller's
// real plan for tonight (rivianNightPlan), the trip layer, the typed needs and a high per day, run
// through lib/chargeCalendar.ts for the coming nights. Both consumers get the same view.
// Never throws on missing parts: no car state, no calendars or no forecast just leave blanks.
import { readConfig } from '@/lib/config';
import { arrivalFloorOf, dayTimeMs, localDayNumber, nextUseDay, topUpLimitFor } from '@/lib/chargePlan';
import { CHARGE_CAL_DAYS, projectNights, type CalDayIn, type CalNight, type UseSource } from '@/lib/chargeCalendar';
import { readDailyUse } from '@/lib/driveLogStore';
import { personalCalendarOn } from '@/lib/personalCalendar';
import { readPlanStore } from '@/lib/planAlertStore';
import { localDate } from '@/lib/rivianDailyUse';
import { cachedForecastTemps, rivianNightPlan, RIVIAN_MAX_AMPS, RIVIAN_MIN_AMPS, type RivianPlanRun } from '@/lib/rivianNightPlan';
import { readOverride } from '@/lib/rivianOverrideStore';
import type { ForecastDayIn } from '@/lib/forecastCalEvents';
import { highOnDay, type ForecastTemp } from '@/lib/rivianPlan';
import { milesForPct, needUsePct } from '@/lib/tripPlan';
import { computeTrips, type DayView } from '@/lib/tripRun';
import { readTripChoices, type ManualNeed } from '@/lib/tripStore';

export interface CalDay {
  day: number;
  date: string;                 // YYYY-MM-DD, local
  label: string;                // "Nov 12"
  weekday: number;              // 0 = Monday
  inRange: boolean;             // today .. today + 13 (the rest of the week grid is padding)
  past: boolean;
  today: boolean;
  isWork: boolean;
  away: boolean;
  shiftLabel: string | null;    // "6:00 AM - 2:30 PM"
  usePct: number | null;        // expected use, no margin; null for past / padding days
  miles: number | null;
  source: UseSource | null;
  highF: number | null;
  typed: ManualNeed | null;
  typedBelow: boolean;          // a typed need under the forecast: ignored, the plan only goes up
  actual: { usedPct: number | null; miles: number } | null;   // past days, from the daily-use log
  night: CalNight | null;       // the night before this day
}

export interface CalHeader {
  socPct: number | null;
  limitPct: number | null;
  plugged: boolean | null;
  charging: boolean | null;
  serveLabel: string | null;    // the day tonight's charge serves
  plugIn: boolean | null;
  amps: number | null;
  windowLabel: string | null;
  windowHours: number | null;
  addPct: number | null;
  kwh: number | null;
  raiseLimitTo: number | null;
  shortfall: boolean;
  controlOn: boolean;
  override: { targetPct: number; byMs: number; auto: boolean } | null;
}

export interface ChargeCalendarView {
  nowMs: number;
  header: CalHeader;
  weeks: CalDay[][];
  floorPct: number | null;
  limitPct: number | null;
  tripsOn: boolean;
  tripsRead: boolean;
  planKnown: boolean;           // the real plan exists (the car's SoC may still be unknown)
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const weekdayOf = (day: number) => (((day + 3) % 7) + 7) % 7;   // 1970-01-01 was a Thursday

function highsFor(run: RivianPlanRun, serveDay: number, temps: ForecastTemp[]): (day: number) => number | null {
  return (day) => (day === serveDay && run.forecastHighF !== null ? run.forecastHighF : highOnDay(temps, day));
}

export async function chargeCalendarView(nowMs: number): Promise<ChargeCalendarView> {
  const today = localDayNumber(nowMs);
  // The controller's cached forecast for the serve day, so night 0 reads what the controller reads.
  const store = await readPlanStore().catch(() => null);
  const serve = nextUseDay(nowMs);
  const sf = store?.forecast?.day === serve ? store.forecast : null;
  const run = await rivianNightPlan(nowMs, { forecastHighF: sf?.highF ?? null, forecastTemps: sf?.temps ?? [] });
  const built = run.built;
  const serveDay = built?.serveDay ?? serve;
  const temps = [...(sf?.temps ?? []), ...(await cachedForecastTemps(nowMs).catch(() => []))];
  const highOf = highsFor(run, serveDay, temps);

  const layer = await computeTrips(run, nowMs).catch(() => null);
  const trips = new Map<number, DayView>((layer?.days ?? []).map((d) => [d.day, d]));
  const needs = (await readTripChoices()).needs;
  const daily = await readDailyUse().catch(() => []);
  const dailyBy = new Map(daily.map((r) => [r.date, r]));
  const floor = arrivalFloorOf(readConfig().vehicles.rivian);
  const lastDay = today + CHARGE_CAL_DAYS - 1;

  // One entry per day from today: its kind, its expected use and where that came from.
  const info = new Map<number, CalDayIn & { miles: number | null; typed: ManualNeed | null; typedBelow: boolean }>();
  for (let day = today; day <= lastDay; day++) {
    const t = trips.get(day);
    const isWork = !!run.workDays?.has(day) || run.shifts.some((s) => s.day === day);
    const away = !!t?.away;
    const highF = highOf(day) ?? t?.highF ?? null;
    const typed = needs[String(day)] ?? null;
    // The forecast first (trip, else the model), then a typed need over it: it only raises.
    let usePct: number, source: UseSource, miles: number | null;
    if (away) {
      usePct = 0; source = 'trip'; miles = null;
    } else if (t?.plan && t.adj && !t.plan.unroutable && t.plan.miles > 0) {
      usePct = isWork ? t.baseNeedPct + t.adj.tripPct : Math.max(t.baseNeedPct, t.adj.tripPct);
      source = 'trip'; miles = isWork ? milesForPct(usePct, highF) : Math.round(t.plan.miles);
    } else if (built) {
      usePct = isWork ? built.usePctWork : built.usePctOff;
      const src = isWork ? built.needSource.work : built.needSource.off;
      source = src === 'charge-history' ? 'charge history' : isWork ? 'work model' : 'day-off average';
      miles = milesForPct(usePct, highF);
    } else {
      usePct = isWork ? 20 : 10; source = 'default'; miles = milesForPct(usePct, highF);
    }
    let typedBelow = false;
    if (typed) {
      const tp = needUsePct(typed, highF);
      if (tp >= usePct || away) {
        usePct = tp; source = 'typed';
        miles = typed.unit === 'mi' ? typed.value : milesForPct(tp, highF);
      } else typedBelow = true;
    }
    info.set(day, { day, isWork, away, usePct, useSource: source, highF, tripMiles: t?.plan?.miles ?? null, miles, typed, typedBelow });
  }

  // Nights from the one the plan serves to the end of the calendar.
  const nights = new Map<number, CalNight>();
  let limitPct: number | null = run.state?.chargeLimit ?? null;
  if (built) {
    const days: CalDayIn[] = [];
    for (let day = Math.max(serveDay, today); day <= lastDay; day++) days.push(info.get(day)!);
    for (const n of projectNights({
      days, shifts: run.shifts, startSocPct: built.socUsed, limitPct, floorPct: floor.arrivalFloorPct, margin: floor.arrivalDriveMargin,
      kwhPerPct: run.kwhPerPct, minAmps: RIVIAN_MIN_AMPS, maxAmps: RIVIAN_MAX_AMPS, topUpLimitFor,
      tonight: built.result.plan,
    })) nights.set(n.day, n);
  }
  if (limitPct !== null && !(limitPct > 0)) limitPct = null;

  // The week grid: Monday on or before today to the Sunday on or after the last day.
  const first = today - weekdayOf(today);
  const end = lastDay + (6 - weekdayOf(lastDay));
  const weeks: CalDay[][] = [];
  for (let day = first; day <= end; day++) {
    const i = info.get(day);
    const inRange = day >= today && day <= lastDay;
    const date = localDate(dayTimeMs(day, 12));
    const act = day < today ? dailyBy.get(date) : undefined;
    const shifts = run.shifts.filter((s) => s.day === day);
    const shiftLabel = shifts.length
      ? `${clock(Math.min(...shifts.map((s) => s.startMs)))} - ${clock(Math.max(...shifts.map((s) => s.endMs)))}` : null;
    const cell: CalDay = {
      day, date, label: new Date(dayTimeMs(day, 12)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      weekday: weekdayOf(day), inRange, past: day < today, today: day === today,
      isWork: i ? i.isWork : shifts.length > 0, away: !!i?.away, shiftLabel,
      usePct: i?.usePct ?? null, miles: i?.miles ?? null, source: i?.useSource ?? null, highF: i?.highF ?? null, typed: i?.typed ?? null, typedBelow: i?.typedBelow ?? false,
      actual: act && !act.unknown ? { usedPct: act.used_pct, miles: act.miles } : null,
      night: nights.get(day) ?? null,
    };
    if ((day - first) % 7 === 0) weeks.push([]);
    weeks[weeks.length - 1].push(cell);
  }

  const plan = built?.result.plan ?? null;
  const n0 = nights.get(serveDay) ?? null;
  const manual = await readOverride(nowMs).catch(() => null);
  const ov = manual ?? layer?.override ?? null;
  const w = built?.result.window ?? null;
  const header: CalHeader = {
    socPct: run.state?.chargePercent ?? null, limitPct: run.state?.chargeLimit ?? null,
    plugged: run.state?.isPluggedIn ?? null, charging: run.state?.isCharging ?? null,
    serveLabel: built ? new Date(dayTimeMs(built.serveDay, 12)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : null,
    plugIn: n0 ? n0.charge : null, amps: plan?.amps ?? null,
    windowLabel: w && plan && plan.windowHours > 0 ? `${clock(w.startMs)} - ${clock(w.endMs)}` : null,
    windowHours: plan?.windowHours ?? null, addPct: n0 ? n0.addedPct : plan?.totalPct ?? null, kwh: n0 ? n0.kwh : plan?.kwh ?? null,
    raiseLimitTo: plan?.raiseLimitTo ?? null, shortfall: plan?.shortfall ?? false,
    controlOn: process.env.RIVIAN_SCHEDULE_CONTROL === '1',
    override: ov ? { targetPct: ov.targetPct, byMs: ov.byMs, auto: !manual } : null,
  };
  return {
    nowMs, header, weeks, floorPct: floor.arrivalFloorPct, limitPct,
    tripsOn: personalCalendarOn(), tripsRead: !!layer, planKnown: !!built,
  };
}

// The days the forecast calendar covers: today on, each with its night when the plan has one.
export function viewDays(v: ChargeCalendarView): CalDay[] {
  return v.weeks.flat().filter((d) => d.inRange);
}

// The forecast calendar's days: today on, the number the title shows and the night before.
export function forecastDays(v: ChargeCalendarView): ForecastDayIn[] {
  return viewDays(v).map((d) => ({
    date: d.date, day: d.day, miles: d.miles, pct: d.usePct, source: d.source ?? 'default', highF: d.highF, typed: d.typed, typedBelow: d.typedBelow, away: d.away,
    night: d.night ? { plug: d.night.charge, amps: d.night.amps, windowHours: d.night.windowHours, morningPct: d.night.morningPct, arrivalPct: d.night.arrivalPct } : null,
  }));
}
