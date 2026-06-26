import { readSolarLive } from '@/lib/solaredge';

export const dynamic = 'force-dynamic';

// Live SolarEdge inverter snapshot. Cheap to hit — the underlying read is
// cached for `solar.pollIntervalSec` seconds (default 10) so multiple
// dashboard fetches share one Modbus connection.
//
// Returns { enabled: false } when the user hasn't enabled SolarEdge in
// /admin yet, so the dashboard can render nothing rather than an error.
export async function GET() {
  const live = await readSolarLive();
  return Response.json(live);
}
