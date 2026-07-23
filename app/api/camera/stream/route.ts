import { spawn } from 'node:child_process';
import { readConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';

// Server-side camera stream endpoint. Two source types:
//
// - type 'rtsp': the camera speaks RTSP directly (e.g. a Reolink camera/NVR)
//   and streamUrl holds an rtsp:// URL with credentials. Browsers can't play
//   RTSP, so ffmpeg transcodes it to an MJPEG multipart stream in real time.
//   This also sidesteps Scrypted's own MJPEG re-compression, which was the
//   likely cause of the blurry (vs. frozen) picture reported after the
//   Scrypted-proxy fix — going straight to the camera's own encode instead.
// - type 'mjpeg' (e.g. Scrypted's MJPEG Rebroadcast plugin): streamUrl is
//   already an HTTP MJPEG multipart source, just proxied through as-is.
//
// Either way the container reaches the camera's LAN address even when the
// browser viewing the page can't (Cloudflare Tunnel, a different VLAN, etc).
export async function GET() {
  const { streamUrl, type } = readConfig().camera;
  if (!streamUrl) return Response.json({ error: 'camera.streamUrl not configured' }, { status: 404 });

  if (type === 'rtsp') return streamViaFfmpeg(streamUrl);
  return proxyMjpeg(streamUrl);
}

function streamViaFfmpeg(rtspUrl: string): Response {
  // -rtsp_transport tcp: avoids UDP packet loss/corruption over Wi-Fi/VLANs,
  // at the cost of slightly higher latency -- fine for a viewing-only feed.
  // -f mpjpeg (not plain -f mjpeg) because the <img> tag needs real
  // multipart/x-mixed-replace framing (boundary + per-part Content-Type) to
  // know where one JPEG frame ends and the next begins -- raw concatenated
  // JPEGs wouldn't render as a stream at all. -boundary_tag pins the
  // boundary string to match what's declared in the response header below.
  const ff = spawn('ffmpeg', [
    '-rtsp_transport', 'tcp',
    '-i', rtspUrl,
    '-f', 'mpjpeg',
    '-boundary_tag', 'ffmpeg',
    '-q:v', '5',
    '-r', '10',
    '-',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  ff.stderr.on('data', () => { /* ffmpeg logs progress to stderr even on success; not logged here to avoid noise */ });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      ff.stdout.on('data', (chunk: Buffer) => {
        try { controller.enqueue(chunk); } catch { /* controller already closed */ }
      });
      ff.stdout.on('end', () => { try { controller.close(); } catch { /* already closed */ } });
      ff.on('error', (e) => { try { controller.error(e); } catch { /* already closed */ } });
    },
    cancel() {
      ff.kill('SIGKILL');
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'multipart/x-mixed-replace; boundary=ffmpeg',
      'Cache-Control': 'no-store',
    },
  });
}

async function proxyMjpeg(streamUrl: string): Promise<Response> {
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
