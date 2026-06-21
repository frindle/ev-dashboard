import { readConfig } from '@/lib/config';
import { fetchWallConnectorList } from '@/lib/tesla';

export const dynamic = 'force-dynamic';

export async function GET() {
  const cfg = readConfig();
  try {
    const list = await fetchWallConnectorList(cfg.energySite.id);
    console.log('[wall-connectors] discovered:', JSON.stringify(list));
    return Response.json(list);
  } catch (e) {
    console.error('[wall-connectors] error:', e);
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
