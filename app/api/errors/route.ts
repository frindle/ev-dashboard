import { NextRequest } from 'next/server';
import { logError } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// Sink for client-side errors. The browser POSTs here from window.onerror /
// onunhandledrejection so errors get persisted to keys/errors.log alongside
// server-side ones — otherwise an iPad kiosk error is invisible.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { source?: string; message?: string; stack?: string; extra?: Record<string, unknown> };
    const err = new Error(body.message ?? 'unknown client error');
    if (body.stack) err.stack = body.stack;
    await logError(body.source ?? 'client', err, body.extra);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 400 });
  }
}
