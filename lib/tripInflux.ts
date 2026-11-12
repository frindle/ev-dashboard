// ev_trip_plan: one point per planned day, written at that day's local
// midnight so a later run overwrites it. Fields: day, miles, pct, target,
// by_ms. Nothing else: no title, place or coordinates, ever.
import { localMidnightMs } from './planInflux.ts';

export const TRIP_MEASUREMENT = 'ev_trip_plan';

export interface TripPoint { day: number; miles: number; pct: number; target: number; byMs: number | null }

export function tripPlanLine(t: TripPoint): string {
  const f = (n: number) => Math.round(n * 100) / 100;
  const parts = [`day=${t.day}`, `miles=${f(t.miles)}`, `pct=${f(t.pct)}`, `target=${f(t.target)}`];
  if (t.byMs !== null && Number.isFinite(t.byMs)) parts.push(`by_ms=${Math.round(t.byMs)}`);
  return `${TRIP_MEASUREMENT} ${parts.join(',')} ${localMidnightMs(t.day)}`;
}
