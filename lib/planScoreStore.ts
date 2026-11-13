// The scored days (KEYS_DIR/plan-scores.json), newest last. Doubles as the record of which days
// still lack a use or peak score (lib/planScoreRun.ts rescores those). No coordinates, no titles.
import { existsSync } from 'fs';
import { readFile, rename, writeFile } from 'fs/promises';
import { join } from 'path';
import type { ScoreEntry } from '@/lib/planScore';

export const KEEP_DAYS = 120;

function path(): string {
  return join(process.env.KEYS_DIR ?? join(process.cwd(), 'keys'), 'plan-scores.json');
}

export async function readScores(): Promise<ScoreEntry[]> {
  if (!existsSync(path())) return [];
  try {
    const j = JSON.parse(await readFile(path(), 'utf-8')) as { entries?: ScoreEntry[] };
    return Array.isArray(j.entries) ? j.entries : [];
  } catch {
    return [];
  }
}

export async function writeScores(entries: ScoreEntry[]): Promise<void> {
  const sorted = [...entries].sort((a, b) => a.day - b.day).slice(-KEEP_DAYS);
  const tmp = path() + '.tmp';
  await writeFile(tmp, JSON.stringify({ entries: sorted }));
  await rename(tmp, path());
}
