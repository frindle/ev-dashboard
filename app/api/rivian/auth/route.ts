import { NextRequest } from 'next/server';
import { rivianLogin, readRivianTokens } from '@/lib/rivian';

export const dynamic = 'force-dynamic';

// POST /api/rivian/auth
// Body: { email, password }
// Returns: { type: 'success' } | { type: 'otp_required', otpToken, csrfToken, appSessionToken }
export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json() as { email: string; password: string };
    if (!email || !password) {
      return Response.json({ error: 'email and password required' }, { status: 400 });
    }
    const result = await rivianLogin(email, password);
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

// GET /api/rivian/auth — check connection status
export async function GET() {
  const tokens = readRivianTokens();
  return Response.json({
    connected: tokens !== null,
    vehicleId: tokens?.vehicleId ?? null,
    savedAt: tokens?.savedAt ?? null,
  });
}
