import { readConfig } from '@/lib/config';
import { fetchWallConnectorList } from '@/lib/tesla';

export const dynamic = 'force-dynamic';

export async function GET() {
  const cfg = readConfig();

  // Config baseline — always available (serials seeded from defaults)
  const configList = cfg.energySite.wallConnectors.map(w => ({
    deviceId: w.deviceId,
    serial: w.serial,
    side: w.side,
  }));

  try {
    const apiList = await fetchWallConnectorList(cfg.energySite.id);
    console.log('[wall-connectors] api returned:', JSON.stringify(apiList));

    if (apiList.length > 0) {
      // Merge: prefer API serial, fall back to config serial
      const merged = apiList.map(w => ({
        ...w,
        serial: w.serial || configList.find(c => c.deviceId === w.deviceId)?.serial || '',
      }));
      return Response.json(merged);
    }
  } catch (e) {
    console.error('[wall-connectors] components API error:', e);
  }

  // Fall back to config data so the dropdown always has something to show
  return Response.json(configList);
}
