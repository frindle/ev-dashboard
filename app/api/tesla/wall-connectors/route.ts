import { readConfig } from '@/lib/config';
import { fetchWallConnectorList } from '@/lib/tesla';

export const dynamic = 'force-dynamic';

export async function GET() {
  const cfg = readConfig();
  try {
    const list = await fetchWallConnectorList(cfg.energySite.id);
    return Response.json(list);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
