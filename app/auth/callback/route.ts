import { NextRequest } from 'next/server';
import { writeTokens, TeslaTokens } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const error = req.nextUrl.searchParams.get('error');

  if (error) {
    return new Response(`Tesla auth error: ${error}`, { status: 400 });
  }
  if (!code) {
    return new Response('No code received', { status: 400 });
  }

  const res = await fetch('https://auth.tesla.com/oauth2/v3/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: process.env.TESLA_CLIENT_ID,
      client_secret: process.env.TESLA_CLIENT_SECRET,
      code,
      redirect_uri: process.env.TESLA_REDIRECT_URI ?? 'https://ev-dashboard.penndalton.com/auth/callback',
    }),
  });

  const data = await res.json() as TeslaTokens;

  if (!res.ok) {
    return new Response(`Token exchange failed: ${JSON.stringify(data)}`, { status: 500 });
  }

  writeTokens(data);

  return new Response('✓ Tesla auth complete. Tokens saved. You can close this tab.', {
    headers: { 'Content-Type': 'text/plain' },
  });
}
