import { NextRequest } from 'next/server';
import { readConfig, writeConfig, AppConfig } from '@/lib/config';
import { hasTokens } from '@/lib/tesla';

export const dynamic = 'force-dynamic';

export async function GET() {
  const cfg = readConfig();
  return Response.json({
    config: cfg,
    teslaConnected: hasTokens(),
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as AppConfig;
    writeConfig(body);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 400 });
  }
}
