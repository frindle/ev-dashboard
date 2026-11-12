// Penn's answers to conflicting shifts on the calendar (EV charge plan #1):
// events he marked "ignore" are skipped by UID. Deleting the event itself
// waits for Nextcloud write access, so ignore is the only choice for now.
// Stored in KEYS_DIR/shift-choices.json by lib/shiftChoicesStore.ts. Pure (node:test can
// load this file).
import type { Shift } from './chargePlan.ts';

export interface ShiftChoices {
  ignoredUids: string[];
}

export function applyIgnored(
  shifts: Shift[], workDays: Set<number> | null, ignored: Set<string>,
): { shifts: Shift[]; workDays: Set<number> | null } {
  if (!ignored.size) return { shifts, workDays };
  const kept = shifts.filter((s) => !(s.uid && ignored.has(s.uid)));
  if (!workDays) return { shifts: kept, workDays };
  const left = new Set(kept.map((s) => s.day));
  // a day whose every shift was ignored is no longer a work day
  const dropped = new Set(shifts.filter((s) => !left.has(s.day)).map((s) => s.day));
  return { shifts: kept, workDays: new Set([...workDays].filter((d) => !dropped.has(d))) };
}

export function validChoice(body: unknown): { uid: string } | null {
  const b = body as { uid?: unknown; action?: unknown } | null;
  if (!b || b.action !== 'ignore' || typeof b.uid !== 'string' || !b.uid || b.uid.length > 300) return null;
  return { uid: b.uid };
}
