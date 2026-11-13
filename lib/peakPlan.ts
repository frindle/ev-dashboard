// Demand-aware amps for the coming nights (EV plan Rev 18). Pure: node:test loads it directly.
//
// The goal (Penn 11-12): make sure each morning has enough charge (25% home after the day's use
// x 1.1) and keep the daily demand charge as low as possible, aiming to stay under the day's peak
// outside the charging window. A charging night's draw is set by its amps, not its hours, so a
// night that charges runs the whole window at one amp setting and the car's limit stops it.
//
// Every amp setting (or no charge) is tried for tonight and the next two nights. Each plan is
// scored by, in order: charge short of a morning's need, the expected demand charge (over the
// room left under the line, averaged over the room spread, plus the cost of the charge still
// owed after the last night), the most any night goes over, then the higher morning tonight
// (charge that costs nothing now is charge that doesn't cost later). Tonight's amps come from the
// best plan; the plan is redone every write slot with the real state.

export const DEMAND_USD_PER_KW_DAY = 0.14;   // reported NV Energy rate from 2027-01-01 (Rev 14)
export const KW_PER_AMP = 240 / 1000;
export const AMP_STEP = 2;
const SHORT_USD_PER_PCT = 50;               // far above any demand cost: never short to save money
const COST_EPS = 0.005;
const FULL_WINDOW_HOURS = 8;

export interface PeakNightIn {
  aimKw: number | null;     // the line to stay under (display)
  houseKw: number | null;   // the house's night load (display)
  headroomKw: number[];     // room under the line, equal-weight scenarios; [] = unknown (no room)
}

export interface PeakHorizonNight extends PeakNightIn {
  hours: number;            // charge hours that night
  usePct: number;           // the day's expected use in %, no margin
}

export interface PeakPlanInput {
  socPct: number;           // SoC going into tonight
  limitPct: number;
  floorPct: number;
  margin: number;
  kwhPerPct: number;
  nights: PeakHorizonNight[];   // [0] = tonight
  minAmps: number;
  maxAmps: number;
}

export interface PeakChoice {
  amps: Array<number | null>;   // per night; null = no charge
  morningPct: number[];
  requiredPct: number[];        // lowest morning per night that keeps every later morning reachable
  overKw: number[];             // middle scenario: kW over the line, 0 = under it
  costUsd: number[];            // expected demand charge per night
  totalUsd: number;             // the nights plus the charge still owed after them
  shortPct: number;             // morning charge missing over the horizon (0 unless even 48A can't)
}

const scenarios = (n: PeakNightIn) => (n.headroomKw.length ? n.headroomKw : [0]);
const middle = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

export function nightCostUsd(amps: number | null, headroomKw: number[]): number {
  if (!amps) return 0;
  const hs = headroomKw.length ? headroomKw : [0];
  return hs.reduce((s, h) => s + DEMAND_USD_PER_KW_DAY * Math.max(0, amps * KW_PER_AMP - Math.max(0, h)), 0) / hs.length;
}

export function overKwOf(amps: number | null, headroomKw: number[]): number {
  if (!amps) return 0;
  return Math.max(0, amps * KW_PER_AMP - Math.max(0, middle(headroomKw.length ? headroomKw : [0])));
}

export function ampSteps(minAmps: number, maxAmps: number): number[] {
  const out: number[] = [];
  for (let a = minAmps; a < maxAmps; a += AMP_STEP) out.push(a);
  out.push(maxAmps);
  return out;
}

const gainPct = (amps: number, hours: number, kwhPerPct: number) => (amps * KW_PER_AMP * hours) / kwhPerPct;

export function morningOf(soc: number, amps: number | null, hours: number, limit: number, kwhPerPct: number): number {
  if (!amps || hours <= 0 || soc >= limit) return soc;
  return Math.min(limit, soc + gainPct(amps, hours, kwhPerPct));
}

// Lowest amps (in steps) that add `pct` over `hours`; maxAmps when even that falls short.
function ampsToAdd(pct: number, hours: number, p: PeakPlanInput): number | null {
  if (pct <= 1e-9) return null;
  for (const a of ampSteps(p.minAmps, p.maxAmps)) if (gainPct(a, hours, p.kwhPerPct) >= pct - 1e-9) return a;
  return p.maxAmps;
}

export function requiredMornings(p: PeakPlanInput): number[] {
  const n = p.nights;
  const need = n.map((x) => Math.min(p.limitPct, p.floorPct + Math.max(0, x.usePct) * p.margin));
  const req = need.slice();
  for (let k = n.length - 2; k >= 0; k--) {
    const nextMax = n[k + 1].hours > 0 ? gainPct(p.maxAmps, n[k + 1].hours, p.kwhPerPct) : 0;
    req[k] = Math.min(p.limitPct, Math.max(need[k], req[k + 1] - nextMax + Math.max(0, n[k].usePct) * p.margin));
  }
  return req;
}

interface Scored { amps: Array<number | null>; morning: number[]; cost: number[]; total: number; short: number; maxOver: number; sumAmps: number }

export function planNights(p: PeakPlanInput): PeakChoice {
  const n = p.nights;
  const steps = ampSteps(p.minAmps, p.maxAmps);
  const need = n.map((x) => Math.min(p.limitPct, p.floorPct + Math.max(0, x.usePct) * p.margin));
  const meanUse = n.reduce((s, x) => s + Math.max(0, x.usePct), 0) / Math.max(1, n.length);
  const owedNeed = Math.min(p.limitPct, p.floorPct + meanUse * p.margin);
  const pooled = n.flatMap((x) => scenarios(x));

  let best: Scored | null = null;
  const better = (a: Scored, b: Scored): boolean => {
    if (Math.abs(a.short - b.short) > 1e-6) return a.short < b.short;
    if (Math.abs(a.total - b.total) > COST_EPS) return a.total < b.total;
    if (Math.abs(a.maxOver - b.maxOver) > 1e-6) return a.maxOver < b.maxOver;
    if (Math.abs(a.morning[0] - b.morning[0]) > 1e-6) return a.morning[0] > b.morning[0];
    return a.sumAmps < b.sumAmps;
  };

  const amps: Array<number | null> = new Array(n.length).fill(null);
  const morning: number[] = new Array(n.length).fill(0);
  const walk = (k: number, soc: number) => {
    if (k === n.length) {
      let short = 0, total = 0, maxOver = 0, sumAmps = 0;
      const cost: number[] = [];
      for (let i = 0; i < n.length; i++) {
        short += Math.max(0, need[i] - morning[i]);
        const c = nightCostUsd(amps[i], scenarios(n[i]));
        cost.push(c);
        total += c;
        maxOver = Math.max(maxOver, overKwOf(amps[i], scenarios(n[i])));
        sumAmps += amps[i] ?? 0;
      }
      // The charge still owed after the last night, as one full night at the pooled room.
      const owed = Math.max(0, owedNeed - soc);
      const owedAmps = ampsToAdd(owed, FULL_WINDOW_HOURS, p);
      total += nightCostUsd(owedAmps, pooled);
      const owedShort = owedAmps === null ? 0 : Math.max(0, owed - gainPct(owedAmps, FULL_WINDOW_HOURS, p.kwhPerPct));
      total += SHORT_USD_PER_PCT * (short + 0.5 * owedShort);
      const s: Scored = { amps: amps.slice(), morning: morning.slice(), cost, total, short, maxOver, sumAmps };
      if (!best || better(s, best)) best = s;
      return;
    }
    const opts: Array<number | null> = n[k].hours > 0 && soc < p.limitPct ? [null, ...steps] : [null];
    for (const a of opts) {
      amps[k] = a;
      morning[k] = morningOf(soc, a, n[k].hours, p.limitPct, p.kwhPerPct);
      walk(k + 1, Math.max(0, morning[k] - Math.max(0, n[k].usePct) * p.margin));
    }
    amps[k] = null;
  };
  walk(0, p.socPct);

  const b = best as unknown as Scored;
  return {
    amps: b.amps,
    morningPct: b.morning,
    requiredPct: requiredMornings(p),
    overKw: b.amps.map((a, i) => overKwOf(a, scenarios(n[i]))),
    costUsd: b.cost,
    totalUsd: b.total,
    shortPct: b.short,
  };
}
