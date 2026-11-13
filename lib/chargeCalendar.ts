// The /charging calendar: the Rivian's nights projected forward from what is known now (Penn
// 11-12: "a desktop based calendar view to look at forecasted charging"). Pure: node:test loads it.
//
// Each night runs the same rule as the real plan (lib/chargePlan.ts nightPlan, Rev 17): reach 25%
// on getting home after the day's use x margin, at the lowest amps over the window, and the car's
// limit stops it. The projection assumes the arrival push is followed: the car is plugged in on
// the nights that need a charge (it then runs the whole window at those amps) and left unplugged
// on the others, and each day uses its expected amount (no margin). Night 0 is the plan the
// controller writes tonight, passed in as is.
import { CHARGE_VOLTS, nightPlan, nightWindow, type NightPlan, type Shift } from './chargePlan.ts';

export const CHARGE_CAL_DAYS = 14;   // days on the calendar (and how far ahead a need can be typed)

export type UseSource = 'work model' | 'day-off average' | 'charge history' | 'trip' | 'typed' | 'default';

export interface CalDayIn {
  day: number;                  // local day number; the night before it (00:00-08:00) serves it
  isWork: boolean;
  away: boolean;                // inside a multi-day trip: no charging at home the night before
  usePct: number;               // the day's expected use, % of the battery, no margin
  useSource: UseSource;
  highF: number | null;
  tripMiles: number | null;
}

export interface CalNight {
  day: number;
  windowStartMs: number;
  windowEndMs: number;
  windowHours: number;
  charge: boolean | null;       // plug in that night; null = the SoC is unknown, so it can't be told
  amps: number | null;          // null: no charge (not needed, or no window)
  socIn: number | null;         // SoC going into the night
  morningPct: number | null;    // SoC leaving that morning
  reachPct: number | null;      // what the morning needs (floor + use x margin)
  arrivalPct: number | null;    // morning minus the day's expected use
  addedPct: number;
  kwh: number;                  // wall kWh the night draws
  raiseLimitTo: number | null;
  shortfall: boolean;
}

export interface ProjectInput {
  days: CalDayIn[];             // consecutive, [0] = the day tonight's charge serves
  shifts: Shift[];
  startSocPct: number | null;   // SoC going into tonight (the plan's socUsed)
  limitPct: number | null;
  floorPct: number | null;
  margin: number;
  kwhPerPct: number;
  minAmps: number;
  maxAmps: number;
  topUpLimitFor?: (highF: number | null) => number | null;
  tonight?: NightPlan | null;   // the controller's plan for night 0
}

const pct = (amps: number, hours: number, kwhPerPct: number) => (amps * (CHARGE_VOLTS / 1000) * hours) / kwhPerPct;

// The night's plan the way planTonight picks it: one per reading of the calendar, the one that
// needs the most amps.
function planNight(p: ProjectInput, i: number, soc: number | null): NightPlan {
  const d = p.days[i];
  const next = p.days[i + 1] ?? d;
  const w = nightWindow(d.day, p.shifts);
  const nw = nightWindow(d.day + 1, p.shifts);
  const plans: NightPlan[] = [];
  for (const r of d.away ? [{ ...w, hours: 0 }] : w.readings) {
    for (const n of next.away ? [{ ...nw, hours: 0 }] : nw.readings) {
      plans.push(nightPlan({
        isWork: d.isWork, socPct: soc, limitPct: p.limitPct, usePct: d.usePct, margin: p.margin, floorPct: p.floorPct,
        topUpLimitPct: p.topUpLimitFor ? p.topUpLimitFor(d.highF) : null, windowHours: r.hours,
        next: { hours: n.hours, usePct: next.usePct, isWork: next.isWork },
        kwhPerPct: p.kwhPerPct, minAmps: p.minAmps, maxAmps: p.maxAmps,
      }));
    }
  }
  const rank = (x: NightPlan) => (x.amps === null ? -1 : x.amps);
  return plans.reduce((b, x) => (rank(x) > rank(b) || (rank(x) === rank(b) && x.totalPct > b.totalPct) ? x : b), plans[0]);
}

export function projectNights(p: ProjectInput): CalNight[] {
  const out: CalNight[] = [];
  let soc = p.startSocPct;
  const limit = p.limitPct ?? 100;
  for (let i = 0; i < p.days.length; i++) {
    const d = p.days[i];
    const w = nightWindow(d.day, p.shifts);
    const plan = i === 0 && p.tonight ? p.tonight : planNight(p, i, soc);
    const hours = d.away ? 0 : plan.windowHours;
    // Needs a charge: the plan's own need or its short-night buffer (what the arrival push asks for).
    // Night 0 with the demand planner on: its own call on whether to plug in.
    const needed = hours > 0 && plan.amps !== null && (i === 0 && plan.peak ? plan.peak.charge : plan.totalPct > 0.5);
    const charge = soc === null ? null : needed;
    const amps = charge ? plan.amps : null;
    const added = soc === null || !amps ? 0 : Math.max(0, Math.min(Math.max(limit, soc), soc + pct(amps, hours, p.kwhPerPct)) - soc);
    const morning = soc === null ? null : soc + added;
    const arrival = morning === null ? null : morning - Math.max(0, d.usePct);
    out.push({
      day: d.day, windowStartMs: w.startMs, windowEndMs: w.endMs, windowHours: hours,
      charge, amps, socIn: soc, morningPct: morning, reachPct: plan.reachPct, arrivalPct: arrival,
      addedPct: added, kwh: added * p.kwhPerPct, raiseLimitTo: plan.raiseLimitTo, shortfall: plan.shortfall,
    });
    soc = arrival === null ? null : Math.max(0, arrival);
  }
  return out;
}
