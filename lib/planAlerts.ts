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
  plugNeeded: boolean | null;    // plugDecision(): the car's real SoC is short of tomorrow's need; null = unknown
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
  if (c.atHome === true && c.plugged === false && c.plugNeeded !== false && c.lastShiftEndMs !== null
      && c.nowMs >= c.lastShiftEndMs + 30 * 60_000 && c.nowMs < c.lastShiftEndMs + 4 * 3_600_000) {
    add({ key: `unplugged-after-shift:${c.today}`, title: T, priority: 0,
      message: 'You are home after your shift, the Rivian is not plugged in, and tomorrow needs a charge.' });
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

// Plug in or not (Penn 11-12: "i should always get a push notification on
// arrival home ... after work to tell me to plugin or not"). Compares the
// car's real SoC on arrival with what tomorrow morning needs: the 25% arrival
// floor + tomorrow's use x margin, plus any short-night buffer. The night
// plan's own targetPct can't be used here: between 08:00 and 23:00 it takes
// today's use off the SoC (socForPlan), which has already been driven by the
// time the car is home.
export interface PlugInput {
  socPct: number | null;
  reachPct: number | null;       // NightPlan.reachPct
  bufferPct: number;             // NightPlan.bufferPct
  override: { targetPct: number; byMs: number } | null;  // manual or trip target still ahead
}
export interface PlugDecision {
  needed: boolean | null;        // null = no SoC or no plan
  requiredPct: number | null;
  reason: 'tomorrow' | 'override' | null;
}

export function plugDecision(p: PlugInput): PlugDecision {
  const req = p.reachPct === null ? null : p.reachPct + Math.max(0, p.bufferPct);
  const soc = typeof p.socPct === 'number' && Number.isFinite(p.socPct) ? p.socPct : null;
  if (soc === null) return { needed: null, requiredPct: req, reason: null };
  if (req !== null && soc < req - 0.5) return { needed: true, requiredPct: req, reason: 'tomorrow' };
  if (p.override && p.override.targetPct > soc + 0.5) return { needed: true, requiredPct: req, reason: 'override' };
  return { needed: req === null && !p.override ? null : false, requiredPct: req, reason: null };
}

export interface ArrivalCtx {
  nowMs: number;
  today: number;
  sent: Set<string>;
  shiftEndsMs: number[];         // ends of calendar shifts (any day; a night shift ends the next morning)
  socPct: number | null;
  decision: PlugDecision;
  override: { targetPct: number; byMs: number } | null;
  amps: number | null;           // tonight's planned amps
  raiseLimitTo: number | null;
}

const ARRIVE_EARLY_MS = 60 * 60_000;      // left work up to an hour early
const ARRIVE_LATE_MS = 8 * 3_600_000;     // errands after work still count

// One push on the first arrival home after a shift, plug in or not.
export function arrivalPlugAlert(c: ArrivalCtx): Alert | null {
  const afterShift = c.shiftEndsMs.some((e) => c.nowMs >= e - ARRIVE_EARLY_MS && c.nowMs - e <= ARRIVE_LATE_MS);
  const key = `arrived-home:${c.today}`;
  if (!afterShift || c.sent.has(key)) return null;
  const soc = c.socPct === null ? null : Math.round(c.socPct);
  const req = c.decision.requiredPct === null ? null : Math.ceil(c.decision.requiredPct);
  const when = (ms: number) => new Date(ms).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  if (c.decision.needed === null) {
    return { key, title: 'Plug in the Rivian', priority: 0,
      message: soc === null ? 'Home from work. The car\'s charge level is unknown, so plug in to be safe.'
        : `Home from work at ${soc}%. No plan for tomorrow yet, so plug in to be safe.` };
  }
  if (c.decision.needed) {
    const why = c.decision.reason === 'override' && c.override
      ? `The ${c.override.targetPct}% target by ${when(c.override.byMs)} needs a charge.`
      : `Tomorrow needs ${req}% (home with 25% after tomorrow's driving +10%).`;
    const amps = c.amps !== null ? ` Plan: ${c.amps}A from midnight.` : '';
    const limit = c.raiseLimitTo !== null ? ` Raise the charge limit to ${c.raiseLimitTo}%.` : '';
    return { key, title: 'Plug in the Rivian', priority: 0, message: `At ${soc}%. ${why}${amps}${limit}` };
  }
  const covers = req !== null ? `tomorrow needs ${req}%` : `the ${c.override?.targetPct}% target is covered`;
  return { key, title: 'No need to plug in', priority: 0,
    message: `At ${soc}%, and ${covers}. Plugging in anyway adds about 11% at the 8A minimum.` };
}

// Keys older than a few days are dropped from the store.
export function pruneSent(sent: Record<string, number>, nowMs: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, t] of Object.entries(sent)) if (nowMs - t < 4 * 86_400_000) out[k] = t;
  return out;
}
