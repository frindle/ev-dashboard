// Wires the forecast calendar sync (lib/forecastCalSync.ts) into the control loop: polled from the
// /api/dashboard request, throttled to every 5 min, one run at a time, off unless configured.
// Never throws.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chargeCalendarView, forecastDays } from '@/lib/chargeCalendarRun';
import type { SyncState } from '@/lib/forecastCalEvents';
import { forecastCalConfig, syncForecastCalendar, type FetchLike } from '@/lib/forecastCalSync';
import { runRivianChargeControl } from '@/lib/rivianChargeControl';
import { mutateTripChoices } from '@/lib/tripStore';
import { localDayNumber } from '@/lib/chargePlan';

const SYNC_INTERVAL_MS = 5 * 60_000;
const file = () => join(process.env.KEYS_DIR ?? join(process.cwd(), 'keys'), 'forecast-cal.json');

async function readState(): Promise<SyncState> {
  try {
    const raw = JSON.parse(await readFile(file(), 'utf-8')) as Partial<SyncState>;
    return { collection: typeof raw.collection === 'string' ? raw.collection : undefined, days: raw.days && typeof raw.days === 'object' ? raw.days : {} };
  } catch { return { days: {} }; }
}

async function writeState(s: SyncState): Promise<void> {
  await mkdir(join(file(), '..'), { recursive: true });
  await writeFile(file() + '.tmp', JSON.stringify(s));
  await rename(file() + '.tmp', file());
}

let lastMs = 0;
let running = false;

export async function runForecastCalendarSync(): Promise<void> {
  if (running || !forecastCalConfig(process.env)) return;
  const now = Date.now();
  if (now - lastMs < SYNC_INTERVAL_MS) return;
  lastMs = now;
  running = true;
  try {
    await syncForecastCalendar({
      env: process.env, fetchImpl: fetch as unknown as FetchLike, nowMs: now,
      buildWant: async () => forecastDays(await chargeCalendarView(Date.now())),
      setNeed: async (day, need) => {
        const today = localDayNumber(Date.now());
        await mutateTripChoices((c) => {
          for (const k of Object.keys(c.needs)) if (Number(k) < today) delete c.needs[k];
          if (need) c.needs[String(day)] = need; else delete c.needs[String(day)];
        });
      },
      forcePlan: async () => { await runRivianChargeControl({ force: true }); },
      readState, writeState,
    });
  } catch (e) {
    console.error('[forecast-cal] run failed:', e instanceof Error ? e.name : 'error');
  } finally {
    running = false;
  }
}
