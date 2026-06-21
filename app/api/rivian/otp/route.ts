import { NextRequest } from 'next/server';
import { rivianLoginOtp } from '@/lib/rivian';

export const dynamic = 'force-dynamic';

// POST /api/rivian/otp
// Body: { email, otpToken, otpCode, csrfToken, appSessionToken }
export async function POST(req: NextRequest) {
  try {
    const { email, otpToken, otpCode, csrfToken, appSessionToken } =
      await req.json() as {
        email: string;
        otpToken: string;
        otpCode: string;
        csrfToken: string;
        appSessionToken: string;
      };

    if (!email || !otpToken || !otpCode || !csrfToken || !appSessionToken) {
      return Response.json({ error: 'All OTP fields required' }, { status: 400 });
    }

    await rivianLoginOtp(email, otpToken, otpCode, csrfToken, appSessionToken);
    return Response.json({ type: 'success' });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
