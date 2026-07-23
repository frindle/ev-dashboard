import { readConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';

// Server-side proxy for the camera MJPEG stream. The dashboard container can
// reach the camera/Scrypted LAN address even when the browser viewing the
// page can't (Cloudflare Tunnel, a different VLAN, etc.) — the old code had
// the <img> tag hit camera.streamUrl directly from the browser, which is why
// it worked on-LAN but rendered a frozen/blank frame from anywhere else.
export async function GET() {
  const { streamUrl } = readConfig().camera;
  if (!streamUrl) return Response.json({ error: 'camera.streamUrl not configured' }, { status: 404 });

  const controller = new AbortController();
  const connectTimeout = setTimeout(() => controller.abort(), 8000);
  let upstream: Response;
  try {
    upstream = await fetch(streamUrl, { signal: controller.signal, cache: 'no-store' });
  } catch (e) {
    return Response.json({ error: `camera upstream unreachable: ${String(e)}` }, { status: 502 });
  } finally {
    clearTimeout(connectTimeout);
  }
  if (!upstream.ok || !upstream.body) {
    return Response.json({ error: `camera upstream returned ${upstream.status}` }, { status: 502 });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': upstream.headers.get('content-type') ?? 'multipart/x-mixed-replace',
      'Cache-Control': 'no-store',
    },
  });
}
