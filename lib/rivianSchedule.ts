// What the dashboard writes to the Rivian's charging schedule. Pure
// (process-TZ local time), so node:test can load this file.
//
// Charging stays inside the EV rate window, midnight to 08:00 (Penn,
// 2026-11-07): the managed schedule is always forced to EV_WINDOW and only
// its amperage moves. During the window the daily plan is frozen (SoC rises
// as it charges, which would talk the plan down mid-session); only an
// override may raise the amps then.
import type { RivianChargingSchedule } from './rivian.ts';
import type { ChargeWindow } from './chargeOverride.ts';

export const EV_WINDOW: ChargeWindow = { startMin: 0, durationMin: 8 * 60 };

// The schedule the dashboard manages: the enabled one covering the most
// weekdays, else the first. -1 when there are none.
export function managedIndex(list: RivianChargingSchedule[]): number {
  let best = -1;
  list.forEach((s, i) => {
    if (best === -1) { best = i; return; }
    const b = list[best];
    if ((s.enabled && !b.enabled) || (s.enabled === b.enabled && s.weekDays.length > b.weekDays.length)) best = i;
  });
  return best;
}

export function inWindowShape(s: RivianChargingSchedule): boolean {
  return s.enabled && s.startTime === EV_WINDOW.startMin && s.duration === EV_WINDOW.durationMin;
}

// The list to write so the managed schedule runs EV_WINDOW at `amps`. null
// when it already does, or there is no schedule to base it on (its location
// and weekdays come from the car).
export function scheduleWithAmps(list: RivianChargingSchedule[], amps: number): RivianChargingSchedule[] | null {
  const i = managedIndex(list);
  if (i < 0) return null;
  const cur = list[i];
  if (inWindowShape(cur) && cur.amperage === amps) return null;
  return list.map((s, j) => (j === i
    ? { ...s, startTime: EV_WINDOW.startMin, duration: EV_WINDOW.durationMin, amperage: amps, enabled: true }
    : s));
}

export interface AmpsDecision {
  amps: number | null;   // null: leave the car's schedule alone
  reason: string;
}

export function inEvWindow(nowMs: number): boolean {
  const d = new Date(nowMs);
  const min = d.getHours() * 60 + d.getMinutes();
  return min >= EV_WINDOW.startMin && min < EV_WINDOW.startMin + EV_WINDOW.durationMin;
}

export function decideAmps(p: {
  nowMs: number;
  current: RivianChargingSchedule | null;
  dailyAmps: number | null;
  overrideAmps: number | null;
}): AmpsDecision {
  const { current, dailyAmps, overrideAmps } = p;
  if (!current) return { amps: null, reason: 'no charging schedule on the car' };
  const desired = Math.max(dailyAmps ?? 0, overrideAmps ?? 0);
  if (!(desired > 0)) return { amps: null, reason: 'no plan yet' };
  const source = overrideAmps !== null && overrideAmps >= (dailyAmps ?? 0) ? 'override' : 'daily plan';
  if (inEvWindow(p.nowMs)) {
    if (overrideAmps !== null && inWindowShape(current) && overrideAmps > current.amperage) {
      return { amps: overrideAmps, reason: 'override, raised mid-window' };
    }
    return { amps: null, reason: 'charge window running' };
  }
  if (desired !== current.amperage || !inWindowShape(current)) return { amps: desired, reason: source };
  return { amps: null, reason: 'up to date' };
}
