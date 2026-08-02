// lib/chargeHistory.ts
// One place that knows where charge-history.jsonl lives and what a row looks
// like. The dashboard poll appends to it when a wall-connector session ends;
// /api/admin/charge-stats and /api/energy read it back.

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

export interface ChargeHistoryRow {
  side: 'LEFT' | 'RIGHT';
  vehicleName: string;
  startedAt: string;   // ISO
  endedAt: string;     // ISO
  durationMin: number;
  energyKwh: number;
}

function historyPath(): string {
  const dir = process.env.CHARGE_HISTORY_DIR ?? process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
  return join(dir, 'charge-history.jsonl');
}

export async function readChargeHistory(): Promise<ChargeHistoryRow[]> {
  let raw: string;
  try { raw = await readFile(historyPath(), 'utf-8'); }
  catch { return []; }
  const out: ChargeHistoryRow[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line) as ChargeHistoryRow); }
    catch { /* skip malformed */ }
  }
  return out;
}

export async function appendChargeHistory(row: ChargeHistoryRow): Promise<void> {
  try { await writeFile(historyPath(), JSON.stringify(row) + '\n', { flag: 'a' }); }
  catch (e) { console.error('[charge-history] append failed:', e); }
}
