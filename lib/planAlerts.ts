// Pushover alerts for the Rivian charge plan (EV charge plan #3), each sent
// once. Pure decisions here (node:test can load this file); the sent-keys
// store and the sending live in lib/rivianChargeControl.ts and
// lib/planAlertStore.ts.
import type { SlotsDone } from './rivianSchedule.ts';

export interface AlertCtx {
  nowMs: number;
  today: number;                 // local day number of nowMs
  done: SlotsDone;
  sent: Set<string>;
  conflictDay: number | null;    // the day an open shift conflict affects, null when none
  conflictWasOpenDay: number | null; // the day a conflict was open on the last run
  shortfall: boolean;
  atHome: boolean | null;
  plugged: boolean | null;
  lastShiftEndMs: number | null; // today's last shift end
  isOffDay: boolean;
  needsCharge: boolean;          // tonight's plan wants kWh
  limitPct: number | null;
  notChargingPush: boolean;      // from lateStartStep
  serveDay: number;
  dashboardUrl: string | null;
}

export interface Alert {
  key: string;
  title: string;
  message: string;
  priority: number;
  link?: { url: string; urlTitle: string };
}

const T = 'Rivian charge plan';

export function planAlerts(c: AlertCtx): Alert[] {
  const d = new Date(c.nowMs);
  const min = d.getHours() * 60 + d.getMinutes();
  const out: Alert[] = [];
  const add = (a: Alert) => { if (!c.sent.has(a.key)) out.push(a); };
  const link = (day: number) => (c.dashboardUrl
    ? { url: `${c.dashboardUrl.replace(/\/+$/, '')}/shifts?day=${day}`, urlTitle: 'Fix the shifts' } : undefined);

  if (min >= 10 * 60 + 15 && c.done.forecast !== c.today) {
    add({ key: `forecast-missed:${c.today}`, title: T, priority: 0,
      message: 'The 08:15 forecast was not written to the car by 10:15.' });
  }
  if (min >= 23 * 60 + 45 && c.done.update !== c.today) {
    add({ key: `update-missed:${c.today}`, title: T, priority: 1,
      message: 'The 23:00 update was not written to the car by 23:45.' });
  }
  if (c.conflictDay !== null) {
    const day = c.conflictDay;
    add({ key: `conflict:${day}`, title: T, priority: 0, link: link(day),
      message: 'Two shifts on your calendar disagree. The plan uses the shorter charge window until you fix it.' });
    if (min >= 23 * 60) {
      add({ key: `conflict-2300:${c.today}`, title: T, priority: 1, link: link(day),
        message: 'Shift conflict still open at 23:00. Fix it before the car starts charging.' });
    }
    if (min >= 8 * 60 + 15 && min < 12 * 60) {
      add({ key: `conflict-0815:${c.today}`, title: T, priority: 0, link: link(day),
        message: 'Shift conflict still open this morning.' });
    }
  } else if (c.conflictWasOpenDay !== null) {
    add({ key: `conflict-fixed:${c.conflictWasOpenDay}`, title: T, priority: 0,
      message: 'Shift conflict fixed. The charge plan is back on the full window.' });
  }
  if (c.atHome === true && c.plugged === false && c.lastShiftEndMs !== null
      && c.nowMs >= c.lastShiftEndMs + 30 * 60_000 && c.nowMs < c.lastShiftEndMs + 4 * 3_600_000) {
    add({ key: `unplugged-after-shift:${c.today}`, title: T, priority: 0,
      message: 'You are home after your shift and the Rivian is not plugged in.' });
  }
  if (c.isOffDay && min >= 20 * 60 && c.atHome === true && c.plugged === false && c.needsCharge) {
    add({ key: `unplugged-day-off:${c.today}`, title: T, priority: 0,
      message: 'Day off, the Rivian is home and not plugged in, and tonight needs a charge.' });
  }
  if (min >= 8 * 60 + 15 && min < 12 * 60 && c.shortfall) {
    add({ key: `shortfall:${c.today}`, title: T, priority: 0,
      message: 'Tonight and tomorrow cannot be fully charged at 48A in the hours available.' });
  }
  // Only when it should be charging: plugged in and tonight's plan wants kWh.
  // A full car (at its limit) or one away from home is not a problem.
  if (c.notChargingPush && c.plugged === true && c.needsCharge) {
    add({ key: `not-charging:${c.serveDay}`, title: T, priority: 1,
      message: 'The Rivian is not charging 30 minutes after the planned start.' });
  }
  if (min >= 8 * 60 + 15 && min < 12 * 60 && c.limitPct !== null && c.limitPct > 70) {
    add({ key: `limit-high:${c.today}`, title: T, priority: 0,
      message: `The charge limit is ${Math.round(c.limitPct)}%. Drop it back to 70% in the Rivian app.` });
  }
  return out;
}

// Keys older than a few days are dropped from the store.
export function pruneSent(sent: Record<string, number>, nowMs: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, t] of Object.entries(sent)) if (nowMs - t < 4 * 86_400_000) out[k] = t;
  return out;
}
