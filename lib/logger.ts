// Unified error log that captures both server-side and client-side errors
// into a single file the user can tail to debug the dashboard.
//
//   docker exec ev-dashboard-ev-dashboard-1 tail -n 100 /app/keys/errors.log
import { appendFile, stat, rename } from 'fs/promises';
import { join } from 'path';

const MAX_BYTES = 5 * 1024 * 1024; // rotate at 5 MB

function logPath(): string {
  const dir = process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
  return join(dir, 'errors.log');
}

async function rotateIfNeeded(path: string) {
  try {
    const s = await stat(path);
    if (s.size > MAX_BYTES) {
      await rename(path, path + '.1');
    }
  } catch { /* file may not exist yet */ }
}

export async function logError(source: string, err: unknown, extra?: Record<string, unknown>) {
  const path = logPath();
  await rotateIfNeeded(path);
  const ts = new Date().toISOString();
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const stack = err instanceof Error ? err.stack ?? '' : '';
  const extraStr = extra ? ' ' + JSON.stringify(extra) : '';
  const line = `[${ts}] [${source}] ${msg}${extraStr}\n${stack ? stack + '\n' : ''}`;
  try { await appendFile(path, line); }
  catch (e) { console.error('[logger] failed to write errors.log:', e); }
}
