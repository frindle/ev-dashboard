// Structured JSONL log of every outbound API call to a rate-limited provider
// (Rivian, Tesla). One line per call so it can be parsed line-by-line without
// loading the whole file. Read by /api/admin/api-stats for the analysis UI.
//
//   docker exec ev-dashboard-ev-dashboard-1 tail -n 100 /app/keys/api-calls.jsonl
import { appendFile, stat, rename, readFile } from 'fs/promises';
import { join } from 'path';

const MAX_BYTES = 10 * 1024 * 1024; // rotate at 10 MB

function callsPath(): string {
  const dir = process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
  return join(dir, 'api-calls.jsonl');
}

async function rotateIfNeeded(path: string) {
  try {
    const s = await stat(path);
    if (s.size > MAX_BYTES) {
      await rename(path, path + '.1');
    }
  } catch { /* file may not exist yet */ }
}

export interface ApiCallRecord {
  ts: string;
  provider: 'rivian' | 'tesla' | 'solaredge' | 'weather' | 'pushover' | 'other';
  endpoint: string;         // GraphQL op name, or REST path
  status: number;           // HTTP status; 0 for network error
  durationMs: number;
  ok: boolean;
  reason?: string;          // short error tag: 'timeout', 'network', 'throttled', etc.
  backoffActive?: boolean;  // provider had backoff engaged at call time
}

export async function logApiCall(rec: Omit<ApiCallRecord, 'ts'>): Promise<void> {
  const path = callsPath();
  await rotateIfNeeded(path);
  const full: ApiCallRecord = { ts: new Date().toISOString(), ...rec };
  try { await appendFile(path, JSON.stringify(full) + '\n'); }
  catch (e) { console.error('[apiLog] write failed:', e); }
}

// Wrap a fetch call with automatic logging. Returns the raw Response so the
// caller can .json()/.text() it as normal. On network/timeout errors, records
// the failure then re-throws so caller-side handling (backoff, retries) still
// runs unchanged.
export async function loggedFetch(
  provider: ApiCallRecord['provider'],
  endpoint: string,
  input: RequestInfo | URL,
  init?: RequestInit,
  opts?: { backoffActive?: boolean },
): Promise<Response> {
  const t0 = Date.now();
  try {
    const res = await fetch(input, init);
    const durationMs = Date.now() - t0;
    void logApiCall({
      provider,
      endpoint,
      status: res.status,
      durationMs,
      ok: res.ok,
      reason: res.ok ? undefined : httpReason(res.status),
      backoffActive: opts?.backoffActive,
    });
    return res;
  } catch (e) {
    const durationMs = Date.now() - t0;
    const reason = e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'network';
    void logApiCall({
      provider,
      endpoint,
      status: 0,
      durationMs,
      ok: false,
      reason,
      backoffActive: opts?.backoffActive,
    });
    throw e;
  }
}

function httpReason(status: number): string {
  if (status === 429) return 'throttled';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'client_error';
  return 'unknown';
}

// Read + parse the JSONL for analysis. Streams the whole file — safe up to
// the 10 MB rotation threshold, which is ~100k records for typical payloads.
export async function readApiCalls(sinceMs?: number): Promise<ApiCallRecord[]> {
  const path = callsPath();
  let raw: string;
  try { raw = await readFile(path, 'utf-8'); }
  catch { return []; }
  const cutoff = sinceMs ?? 0;
  const out: ApiCallRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as ApiCallRecord;
      if (cutoff && new Date(rec.ts).getTime() < cutoff) continue;
      out.push(rec);
    } catch { /* skip malformed lines */ }
  }
  return out;
}
