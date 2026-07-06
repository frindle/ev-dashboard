import { NextRequest } from 'next/server';
import { readFile } from 'fs/promises';
import { join } from 'path';

export const dynamic = 'force-dynamic';

// Aggregations over charge-history.jsonl — the per-session rows the
// dashboard poll appends when a wall-connector session ends. Nothing was
// reading this file until now.
// Query params:
//   ?months=6      how many calendar months back to include (default 6)
//   ?rate=0.142    $/kWh for cost estimates (optional; cost omitted if absent)

interface ChargeHistoryRow {
  side: 'LEFT' | 'RIGHT';
  vehicleName: string;
  startedAt: string;
  endedAt: string;
  durationMin: number;
  energyKwh: number;
}

interface MonthAgg {
  month: string;        // YYYY-MM
  sessions: number;
  kwh: number;
  costUsd?: number;
}

interface VehicleAgg {
  vehicleName: string;
  side: string;
  totalSessions: number;
  totalKwh: number;
  totalCostUsd?: number;
  avgSessionKwh: number;
  months: MonthAgg[];
}

async function readHistory(): Promise<ChargeHistoryRow[]> {
  const dir = process.env.CHARGE_HISTORY_DIR ?? process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
  let raw: string;
  try { raw = await readFile(join(dir, 'charge-history.jsonl'), 'utf-8'); }
  catch { return []; }
  const out: ChargeHistoryRow[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line) as ChargeHistoryRow); }
    catch { /* skip malformed */ }
  }
  return out;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const months = Math.max(1, Math.min(36, Number(url.searchParams.get('months') ?? '6')));
  const rateRaw = url.searchParams.get('rate');
  const rate = rateRaw != null && !isNaN(Number(rateRaw)) && Number(rateRaw) > 0 ? Number(rateRaw) : null;

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);

  const rows = (await readHistory()).filter(r => {
    const t = new Date(r.startedAt).getTime();
    return !isNaN(t) && t >= cutoff.getTime();
  });

  // vehicleName can be renamed in config over time; bucket by side+name so
  // history stays attributable.
  const byVehicle = new Map<string, ChargeHistoryRow[]>();
  for (const r of rows) {
    const key = `${r.side}|${r.vehicleName}`;
    (byVehicle.get(key) ?? byVehicle.set(key, []).get(key)!).push(r);
  }

  const vehicles: VehicleAgg[] = [];
  for (const [key, list] of byVehicle) {
    const [side, vehicleName] = key.split('|');
    const byMonth = new Map<string, MonthAgg>();
    let totalKwh = 0;
    for (const r of list) {
      totalKwh += r.energyKwh;
      const m = r.startedAt.slice(0, 7);
      const agg = byMonth.get(m) ?? { month: m, sessions: 0, kwh: 0 };
      agg.sessions += 1;
      agg.kwh = Math.round((agg.kwh + r.energyKwh) * 100) / 100;
      byMonth.set(m, agg);
    }
    const monthList = [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month));
    if (rate) for (const m of monthList) m.costUsd = Math.round(m.kwh * rate * 100) / 100;
    vehicles.push({
      vehicleName,
      side,
      totalSessions: list.length,
      totalKwh: Math.round(totalKwh * 100) / 100,
      ...(rate ? { totalCostUsd: Math.round(totalKwh * rate * 100) / 100 } : {}),
      avgSessionKwh: list.length ? Math.round((totalKwh / list.length) * 100) / 100 : 0,
      months: monthList,
    });
  }
  vehicles.sort((a, b) => a.side.localeCompare(b.side));

  const recent = rows
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 25)
    .map(r => ({ ...r, ...(rate ? { costUsd: Math.round(r.energyKwh * rate * 100) / 100 } : {}) }));

  return Response.json({ ok: true, months, ratePerKwh: rate, vehicles, recentSessions: recent });
}
