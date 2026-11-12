// File store for shift choices (KEYS_DIR/shift-choices.json), see shiftChoices.ts.
import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

function choicesPath(): string {
  return join(process.env.KEYS_DIR ?? join(process.cwd(), 'keys'), 'shift-choices.json');
}

export async function readIgnored(): Promise<Set<string>> {
  const path = choicesPath();
  if (!existsSync(path)) return new Set();
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8')) as { ignoredUids?: unknown };
    return new Set(Array.isArray(raw.ignoredUids) ? raw.ignoredUids.filter((u): u is string => typeof u === 'string') : []);
  } catch {
    return new Set();
  }
}

export async function ignoreShift(uid: string): Promise<void> {
  const set = await readIgnored();
  set.add(uid);
  await writeFile(choicesPath(), JSON.stringify({ ignoredUids: [...set] }));
}
