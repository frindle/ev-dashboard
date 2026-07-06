import { loggedFetch } from './apiLog';

// Pushover client. Credentials come from env (.env via docker-compose
// env_file), same convention as the other homelab projects:
//   PUSHOVER_APP_TOKEN — app token from pushover.net/api
//   PUSHOVER_USER_KEY  — your user key
// When either is missing, sendPush is a silent no-op so the dashboard
// works fine without notifications configured.

const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json';

export function pushoverConfigured(): boolean {
  return !!(process.env.PUSHOVER_APP_TOKEN && process.env.PUSHOVER_USER_KEY);
}

export async function sendPush(title: string, message: string, priority = 0): Promise<boolean> {
  const token = process.env.PUSHOVER_APP_TOKEN;
  const user = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) return false;

  try {
    const res = await loggedFetch('pushover', 'messages', PUSHOVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, user, title, message, priority }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[pushover] send failed: HTTP ${res.status} ${body.slice(0, 160)}`);
      return false;
    }
    console.log(`[pushover] sent: ${title}`);
    return true;
  } catch (e) {
    console.warn('[pushover] send threw:', String(e).slice(0, 160));
    return false;
  }
}
