import { readWcDiagnostics } from '@/lib/wcDiagnostics';

export const dynamic = 'force-dynamic';

// Read-back for lib/wcDiagnostics.ts's observational log -- see that
// module's docstring for why it exists (undocumented faultState/
// ocppStatus fields). Grouped by (side, faultState, ocppStatus) so a
// pattern against currentA/powerW range is visible directly in the
// response instead of needing to eyeball raw rows.
export async function GET() {
  const rows = await readWcDiagnostics();

  const groups = new Map<string, {
    side: string; faultState?: number; ocppStatus?: number;
    vehicleConnected: boolean; vehicleCharging: boolean;
    count: number; minCurrentA: number; maxCurrentA: number; minPowerW: number; maxPowerW: number;
    firstSeen: string; lastSeen: string;
  }>();

  for (const r of rows) {
    const key = `${r.side}|${r.faultState}|${r.ocppStatus}|${r.vehicleConnected}|${r.vehicleCharging}`;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, {
        side: r.side, faultState: r.faultState, ocppStatus: r.ocppStatus,
        vehicleConnected: r.vehicleConnected, vehicleCharging: r.vehicleCharging,
        count: 1, minCurrentA: r.currentA, maxCurrentA: r.currentA,
        minPowerW: r.powerW, maxPowerW: r.powerW, firstSeen: r.ts, lastSeen: r.ts,
      });
    } else {
      g.count++;
      g.minCurrentA = Math.min(g.minCurrentA, r.currentA);
      g.maxCurrentA = Math.max(g.maxCurrentA, r.currentA);
      g.minPowerW = Math.min(g.minPowerW, r.powerW);
      g.maxPowerW = Math.max(g.maxPowerW, r.powerW);
      g.lastSeen = r.ts;
    }
  }

  return Response.json({
    ok: true,
    totalRows: rows.length,
    groups: [...groups.values()].sort((a, b) => a.side.localeCompare(b.side) || (a.faultState ?? -1) - (b.faultState ?? -1)),
    rows,
  });
}
