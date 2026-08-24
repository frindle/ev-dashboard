import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

// Readers for the two raw-payload dumps this app already writes but never
// exposed over HTTP:
//
//   keys/rivian-state-debug.json   full GetVehicleState response, rewritten
//                                  every successful poll (lib/rivian.ts)
//   keys/tesla-api-bodies.jsonl    appended response bodies, gated on
//                                  TESLA_LOG_API_BODIES=1 (lib/apiLog.ts)
//
// Both were previously only reachable by shelling into the container, which
// meant nobody looked at them. The mapped dashboard state is lossy on purpose
// -- it only carries fields the app currently knows to check -- so when the
// vehicle does something unmodelled (service mode, an undocumented derate
// string) the raw dump is the only record of what the provider actually sent.

function keysDir(): string {
  return process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
}

// Defensive redaction. The Rivian state dump carries no credentials today and
// the Tesla body log should not either, but both are append-only files fed by
// generic logging helpers: if a token-bearing endpoint is ever added to the
// logged set, the secret would land in a file this endpoint serves over plain
// HTTP. Redact on the way OUT so that stays true regardless of what upstream
// starts logging later. Matching on key name, recursively, not on value shape.
const SECRET_KEY_RE = /token|secret|password|authorization|cookie|csrf|sess|apikey|api_key/i;

export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redact) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // timeStamp is a legitimate vehicleState field on nearly every node and
      // would otherwise be caught by /sess|token/ -- exclude it explicitly
      // rather than loosening the pattern.
      if (k !== 'timeStamp' && SECRET_KEY_RE.test(k)) out[k] = '[REDACTED]';
      else out[k] = redact(v);
    }
    return out as unknown as T;
  }
  return value;
}

export async function readRivianRaw(): Promise<unknown> {
  const p = join(keysDir(), 'rivian-state-debug.json');
  try {
    const txt = await readFile(p, 'utf-8');
    return { source: p, ...redact(JSON.parse(txt) as Record<string, unknown>) };
  } catch (e) {
    return { source: p, error: (e as Error).message, hint: 'written on each successful Rivian poll; absent until one succeeds' };
  }
}

export async function readTeslaRaw(limit: number): Promise<unknown> {
  const p = join(keysDir(), 'tesla-api-bodies.jsonl');
  try {
    await stat(p);
    const txt = await readFile(p, 'utf-8');
    // Tail, not head: this file rotates at 20MB and we want the most recent
    // bodies. Parse per-line so one malformed line can't sink the response.
    const lines = txt.split('\n').filter(Boolean).slice(-limit);
    const entries = lines.map((l) => {
      try { return redact(JSON.parse(l) as unknown); }
      catch { return { parseError: true, raw: l.slice(0, 200) }; }
    });
    return { source: p, count: entries.length, entries };
  } catch (e) {
    return {
      source: p,
      error: (e as Error).message,
      hint: 'requires TESLA_LOG_API_BODIES=1 in the environment',
      enabled: process.env.TESLA_LOG_API_BODIES === '1',
    };
  }
}
