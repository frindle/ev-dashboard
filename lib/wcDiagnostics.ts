// lib/wcDiagnostics.ts
// Observational log for wall_connector_fault_state / ocpp_status --
// undocumented by Tesla, and even Home Assistant's Teslemetry integration
// (the most complete community reverse-engineering effort for this API)
// exposes both as raw, undecoded diagnostic numbers with no enum mapping.
// Added 2026-08-14 after a live puzzle: LEFT showed faultState=7 while
// actively charging (rules out "0=OK, nonzero=fault"), and RIGHT showed
// ocppStatus=1 despite being fully idle/disconnected, same as LEFT's
// mid-charge value (rules out it being the standard OCPP ChargePointStatus
// enum, or at least means it isn't state-dependent the way that enum is).
// Neither a web search nor Home Assistant's own source turned up a
// decoder. Rather than guess further, log real (code, rate, state)
// tuples over time so a pattern -- if any exists -- can be read off
// later instead of reasoned about from two snapshots.
import { appendFile, stat, rename, readFile } from 'fs/promises';
import { join } from 'path';

const MAX_BYTES = 5 * 1024 * 1024; // rotate at 5 MB
const MIN_INTERVAL_MS = 2 * 60_000; // throttle: at most one row per side per 2min, UNLESS the code itself changes

function logPath(): string {
  const dir = process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
  return join(dir, 'wall-connector-diagnostics.jsonl');
}

export interface WcDiagnosticRow {
  ts: string;
  side: 'LEFT' | 'RIGHT';
  vehicleName: string;
  faultState?: number;
  ocppStatus?: number;
  vehicleConnected: boolean;
  vehicleCharging: boolean;
  currentA: number;
  powerW: number;
}

async function rotateIfNeeded(path: string) {
  try {
    const s = await stat(path);
    if (s.size > MAX_BYTES) await rename(path, path + '.1');
  } catch { /* file may not exist yet */ }
}

// Per-side last-logged snapshot, so a genuine code change always logs
// immediately (bypassing the throttle) while an unchanged state only logs
// every MIN_INTERVAL_MS -- enough samples to see rate vary within a
// session without one poll cycle per row forever.
const lastLogged: Partial<Record<'LEFT' | 'RIGHT', { at: number; codeKey: string }>> = {};

export async function logWcDiagnostic(row: Omit<WcDiagnosticRow, 'ts'>): Promise<void> {
  // Nothing to observe if the car was never even plugged in.
  if (!row.vehicleConnected && row.faultState === undefined && row.ocppStatus === undefined) return;

  const codeKey = `${row.faultState}|${row.ocppStatus}|${row.vehicleConnected}|${row.vehicleCharging}`;
  const now = Date.now();
  const prev = lastLogged[row.side];
  const codeChanged = !prev || prev.codeKey !== codeKey;
  if (!codeChanged && prev && now - prev.at < MIN_INTERVAL_MS) return;

  lastLogged[row.side] = { at: now, codeKey };
  const path = logPath();
  await rotateIfNeeded(path);
  const full: WcDiagnosticRow = { ts: new Date().toISOString(), ...row };
  try { await appendFile(path, JSON.stringify(full) + '\n'); }
  catch (e) { console.error('[wcDiagnostics] write failed:', e); }
}

// Read + parse for future analysis (e.g. a small admin summary endpoint,
// or just `docker exec ... cat /app/keys/wall-connector-diagnostics.jsonl`).
export async function readWcDiagnostics(): Promise<WcDiagnosticRow[]> {
  const path = logPath();
  let raw: string;
  try { raw = await readFile(path, 'utf-8'); }
  catch { return []; }
  const out: WcDiagnosticRow[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line) as WcDiagnosticRow); } catch { /* skip malformed */ }
  }
  return out;
}
