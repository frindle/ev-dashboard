// Files for the trip planner (EV charge plan #8), in KEYS_DIR:
//   geo-overrides.json   { "<event uid>": { lat, lon }, "__work__": { lat, lon } }
//                        places picked on /trips (the work location under a fixed key)
//   trip-choices.json    { choices: { "<uid>@<day>": "skip"|"going"|"fix" },
//                          toggles: { "<uid>@<day>": "home"|"straight" },
//                          openDays: [day, ...],    overlap days a push is open for
//                          needs: { "<day>": { value, unit: "pct"|"mi" } } }
//                                                   a day's driving typed on /trips (a place
//                                                   that cannot be found, or any day)
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GeoOverrides } from './geocode.ts';
import type { HomeTag } from './personalCalendar.ts';
import type { OverlapChoice } from './tripPlan.ts';

const dir = () => process.env.KEYS_DIR ?? join(process.cwd(), 'keys');

async function writeJson(path: string, v: unknown): Promise<void> {
  await mkdir(dir(), { recursive: true });
  await writeFile(path + '.tmp', JSON.stringify(v));
  await rename(path + '.tmp', path);
}

const validPoint = (p: unknown): p is { lat: number; lon: number } => {
  const x = p as { lat?: unknown; lon?: unknown } | null;
  return !!x && typeof x.lat === 'number' && typeof x.lon === 'number' && Math.abs(x.lat) <= 90 && Math.abs(x.lon) <= 180;
};

export async function readGeoOverrides(): Promise<GeoOverrides> {
  try {
    const raw = JSON.parse(await readFile(join(dir(), 'geo-overrides.json'), 'utf-8')) as Record<string, unknown>;
    const out: GeoOverrides = {};
    for (const [k, v] of Object.entries(raw)) if (validPoint(v)) out[k] = { lat: v.lat, lon: v.lon };
    return out;
  } catch { return {}; }
}

export async function setGeoOverride(key: string, p: { lat: number; lon: number } | null): Promise<void> {
  const all = await readGeoOverrides();
  if (p) all[key] = { lat: p.lat, lon: p.lon }; else delete all[key];
  await writeJson(join(dir(), 'geo-overrides.json'), all);
}

export interface ManualNeed { value: number; unit: 'pct' | 'mi' }
export const MANUAL_MAX: Record<ManualNeed['unit'], number> = { pct: 100, mi: 600 };

export function validNeed(v: unknown): ManualNeed | null {
  const x = v as Partial<ManualNeed> | null;
  if (!x || (x.unit !== 'pct' && x.unit !== 'mi') || typeof x.value !== 'number' || !Number.isFinite(x.value)) return null;
  if (x.value <= 0 || x.value > MANUAL_MAX[x.unit]) return null;
  return { value: Math.round(x.value), unit: x.unit };
}

export interface TripChoices {
  choices: Record<string, OverlapChoice>;
  toggles: Record<string, HomeTag>;
  openDays: number[];
  needs: Record<string, ManualNeed>;
}

export async function readTripChoices(): Promise<TripChoices> {
  const out: TripChoices = { choices: {}, toggles: {}, openDays: [], needs: {} };
  try {
    const raw = JSON.parse(await readFile(join(dir(), 'trip-choices.json'), 'utf-8')) as Partial<TripChoices>;
    for (const [k, v] of Object.entries(raw.choices ?? {})) if (v === 'skip' || v === 'going' || v === 'fix') out.choices[k] = v;
    for (const [k, v] of Object.entries(raw.toggles ?? {})) if (v === 'home' || v === 'straight') out.toggles[k] = v;
    out.openDays = (raw.openDays ?? []).filter((d) => Number.isInteger(d));
    for (const [k, v] of Object.entries(raw.needs ?? {})) {
      const n = validNeed(v);
      if (n && Number.isInteger(Number(k))) out.needs[k] = n;
    }
  } catch { /* none yet */ }
  return out;
}

export async function writeTripChoices(c: TripChoices): Promise<void> {
  await writeJson(join(dir(), 'trip-choices.json'), c);
}

export async function mutateTripChoices(f: (c: TripChoices) => void): Promise<TripChoices> {
  const c = await readTripChoices();
  f(c);
  await writeTripChoices(c);
  return c;
}
