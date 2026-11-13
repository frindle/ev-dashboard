// GET /api/panel: the compact status JSON for the ESP32 round display (firmware/crowpanel-21). Key legend and the
// ok/st rules are documented in lib/panelFeed.ts. Cached 15 s. Read-only.
//
// No auth, on purpose: it matches the 12.3"/14" display routes (/api/dashboard, /api/energy), which are also open
// because the dashboard has no auth layer and is LAN-only. The body carries no tokens, addresses or vehicle location.
// If auth is added to those routes later, add it here too.
import { makePanelCache } from '@/lib/panelFeed';
import { panelSources } from '@/lib/panelSources';

export const dynamic = 'force-dynamic';

const get = makePanelCache(panelSources);

export async function GET() {
  const body = await get();
  return new Response(body, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
