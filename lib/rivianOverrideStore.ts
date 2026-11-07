// The one-off Rivian charge override (see chargeOverride.ts), persisted in
// KEYS_DIR/rivian-charge-override.json. An expired or malformed file is
// removed on read.
import { existsSync } from 'fs';
import { readFile, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { validOverride, type ChargeOverride } from '@/lib/chargeOverride';

export interface StoredOverride extends ChargeOverride {
  setAtMs: number;
  nudgedAtMs?: number;   // when the Pushover heads-up (limit too low / unreachable) went out
}

function overridePath(): string {
  return join(process.env.KEYS_DIR ?? join(process.cwd(), 'keys'), 'rivian-charge-override.json');
}

export async function readOverride(nowMs = Date.now()): Promise<StoredOverride | null> {
  const path = overridePath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8'));
    const o = validOverride(raw, nowMs);
    if (!o) {
      await unlink(path).catch(() => {});
      return null;
    }
    return {
      ...o,
      setAtMs: typeof raw.setAtMs === 'number' ? raw.setAtMs : 0,
      ...(typeof raw.nudgedAtMs === 'number' ? { nudgedAtMs: raw.nudgedAtMs } : {}),
    };
  } catch {
    return null;
  }
}

export async function writeOverride(o: StoredOverride): Promise<void> {
  await writeFile(overridePath(), JSON.stringify(o));
}

export async function clearOverride(): Promise<void> {
  await unlink(overridePath()).catch(() => {});
}
