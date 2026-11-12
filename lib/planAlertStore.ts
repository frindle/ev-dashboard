// What the plan runner remembers between runs and restarts
// (KEYS_DIR/plan-alerts.json): alerts already sent, the slots done, the target
// the late-start replan aims at, and the cached forecast high.
import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { SlotsDone } from '@/lib/rivianSchedule';

export interface PlanStore {
  sent: Record<string, number>;                       // alert key -> sent at (ms)
  done: SlotsDone;                                    // local day each slot last completed
  target: { day: number; pct: number } | null;        // SoC the coming morning should reach
  lateSeen: number | null;                            // serve day the car was found not charging at start + 15
  replanned: number | null;                           // serve day the late-start replan ran
  forecast: { day: number; highF: number | null; temps?: Array<{ ms: number; tempF: number }> } | null;
  conflictOpenDay: number | null;
}

export const emptyStore = (): PlanStore => ({
  sent: {}, done: {}, target: null, lateSeen: null, replanned: null, forecast: null, conflictOpenDay: null,
});

function storePath(): string {
  return join(process.env.KEYS_DIR ?? join(process.cwd(), 'keys'), 'plan-alerts.json');
}

export async function readPlanStore(): Promise<PlanStore> {
  const path = storePath();
  if (!existsSync(path)) return emptyStore();
  try {
    return { ...emptyStore(), ...(JSON.parse(await readFile(path, 'utf-8')) as Partial<PlanStore>) };
  } catch {
    return emptyStore();
  }
}

export async function writePlanStore(s: PlanStore): Promise<void> {
  await writeFile(storePath(), JSON.stringify(s));
}
