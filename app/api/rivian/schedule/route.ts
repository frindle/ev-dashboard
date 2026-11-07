// Read-only: the Rivian's charging schedules as the car reports them, without
// the location (home coordinates).
import { fetchRivianChargingSchedules } from '@/lib/rivian';
import { managedIndex } from '@/lib/rivianSchedule';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const list = await fetchRivianChargingSchedules();
    if (!list) return Response.json({ error: 'Rivian not connected or backing off' }, { status: 503 });
    return Response.json({
      controlEnabled: process.env.RIVIAN_SCHEDULE_CONTROL === '1',
      managed: managedIndex(list),
      schedules: list.map(({ weekDays, startTime, duration, amperage, enabled }) => ({ weekDays, startTime, duration, amperage, enabled })),
    });
  } catch (e) {
    return Response.json({ error: String(e instanceof Error ? e.message : e).slice(0, 200) }, { status: 502 });
  }
}
