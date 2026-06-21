import { createHash, randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const APP_ID = 'D9D7B25035D549D8A3EA16A9FFB8C927D4A19B55B8944011B2670A8321BF8312';
const CLIENT_ID = 'ANDROID_CGI_MYQ';
const CLIENT_SECRET = 'VUQ0RFhuS3lQV3EyNUJTdw==';
const REDIRECT_URI = 'com.myqops://android';
const IDENTITY_BASE = 'https://partner-identity.myq-cloud.com';
const ACCOUNTS_BASE = 'https://accounts.myq-cloud.com';
const DEVICES_BASE = 'https://devices.myq-cloud.com';
const GDO_BASE = 'https://account-devices-gdo.myq-cloud.com';

const BROWSER_UA = 'Mozilla/5.0 (Linux; Android 11; sdk_gphone_x86 Build/RSR1.210722.013.A6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.106 Mobile Safari/537.36';

const API_HEADERS = {
  'MyQApplicationId': APP_ID,
  'App-Version': '5.242.0.72704',
  'User-Agent': 'sdk_gphone_x86/Android 11',
  'BrandId': '1',
  'Accept-Encoding': 'gzip',
  'Content-Type': 'application/json',
};

// ── PKCE ─────────────────────────────────────────────────────────────────────

function codeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

// ── Cookie jar ────────────────────────────────────────────────────────────────

type CookieJar = Map<string, string>;

function mergeCookies(jar: CookieJar, headers: Headers): void {
  const raw: string[] = [];
  // Node fetch exposes getSetCookie() on the undici Headers implementation
  if (typeof (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function') {
    raw.push(...(headers as unknown as { getSetCookie: () => string[] }).getSetCookie());
  } else {
    const single = headers.get('set-cookie');
    if (single) raw.push(single);
  }
  for (const header of raw) {
    const [nameValue] = header.split(';');
    const eq = nameValue.indexOf('=');
    if (eq < 0) continue;
    jar.set(nameValue.slice(0, eq).trim(), nameValue.slice(eq + 1).trim());
  }
}

function cookieHeader(jar: CookieJar): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

// ── Token storage ─────────────────────────────────────────────────────────────

export interface MyQTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  issued_at: number;
  account_id: string;
}

function tokensPath(): string {
  const dir = process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
  return join(dir, 'myq-tokens.json');
}

export function readMyQTokens(): MyQTokens | null {
  const p = tokensPath();
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')) as MyQTokens; }
  catch { return null; }
}

export function hasMyQTokens(): boolean {
  return readMyQTokens() !== null;
}

function writeMyQTokens(t: MyQTokens): void {
  writeFileSync(tokensPath(), JSON.stringify(t, null, 2));
}

// ── Token refresh ─────────────────────────────────────────────────────────────

async function getAccessToken(): Promise<{ token: string; accountId: string } | null> {
  const stored = readMyQTokens();
  if (!stored) return null;

  const expiresAt = stored.issued_at + stored.expires_in - 300;
  if (Math.floor(Date.now() / 1000) < expiresAt) {
    return { token: stored.access_token, accountId: stored.account_id };
  }

  try {
    const res = await fetch(`${IDENTITY_BASE}/connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: stored.refresh_token,
      }),
    });
    if (!res.ok) return { token: stored.access_token, accountId: stored.account_id };
    const fresh = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
    const updated: MyQTokens = {
      ...fresh,
      issued_at: Math.floor(Date.now() / 1000),
      account_id: stored.account_id,
    };
    writeMyQTokens(updated);
    return { token: fresh.access_token, accountId: stored.account_id };
  } catch {
    return { token: stored.access_token, accountId: stored.account_id };
  }
}

// ── Full auth flow (OAuth 2.0 + PKCE, mimics Android app) ────────────────────

export async function myqLogin(email: string, password: string): Promise<void> {
  const verifier = codeVerifier();
  const challenge = codeChallenge(verifier);
  const jar: CookieJar = new Map();

  // Step 1: GET authorize page → HTML login form
  const authParams = new URLSearchParams({
    client_id: CLIENT_ID,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'MyQ_Residential offline_access',
  });

  const step1 = await fetch(`${IDENTITY_BASE}/connect/authorize?${authParams}`, {
    redirect: 'follow',
    headers: { 'User-Agent': BROWSER_UA },
    signal: AbortSignal.timeout(15000),
  });
  mergeCookies(jar, step1.headers);
  const html = await step1.text();
  const loginUrl = step1.url;

  // Parse hidden __RequestVerificationToken from the form
  const match = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
  if (!match) throw new Error('Could not parse MyQ login form — site may have changed');
  const verificationToken = match[1];

  // Step 2: POST credentials
  const step2 = await fetch(loginUrl, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookieHeader(jar),
      'User-Agent': BROWSER_UA,
      'Referer': loginUrl,
    },
    body: new URLSearchParams({
      Email: email,
      Password: password,
      __RequestVerificationToken: verificationToken,
    }),
    signal: AbortSignal.timeout(15000),
  });
  mergeCookies(jar, step2.headers);

  // Step 3: Follow redirects until we hit com.myqops://android?code=...
  let location = step2.headers.get('location') ?? '';
  let prevRes = step2;

  for (let i = 0; i < 10 && location && !location.startsWith('com.myqops://'); i++) {
    const next = await fetch(location.startsWith('http') ? location : `${IDENTITY_BASE}${location}`, {
      redirect: 'manual',
      headers: { 'Cookie': cookieHeader(jar), 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(15000),
    });
    mergeCookies(jar, next.headers);
    prevRes = next;
    location = next.headers.get('location') ?? '';
  }

  void prevRes; // used only for side-effects above

  if (!location.startsWith('com.myqops://')) {
    throw new Error('MyQ login did not redirect to app — check credentials');
  }

  const codeMatch = location.match(/[?&]code=([^&]+)/);
  if (!codeMatch) throw new Error('No auth code found in MyQ redirect');
  const code = decodeURIComponent(codeMatch[1]);

  // Step 4: Exchange code for tokens
  const tokenRes = await fetch(`${IDENTITY_BASE}/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!tokenRes.ok) throw new Error(`Token exchange failed: ${await tokenRes.text()}`);
  const tokenData = await tokenRes.json() as { access_token: string; refresh_token: string; expires_in: number };

  // Step 5: Get account ID
  const accountRes = await fetch(`${ACCOUNTS_BASE}/api/v6.0/accounts`, {
    headers: { ...API_HEADERS, Authorization: `Bearer ${tokenData.access_token}` },
    signal: AbortSignal.timeout(10000),
  });

  interface AccountsResp { accounts: Array<{ id: string }> }
  const accountData = await accountRes.json() as AccountsResp;
  const accountId = accountData.accounts[0]?.id ?? '';

  writeMyQTokens({
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_in: tokenData.expires_in,
    issued_at: Math.floor(Date.now() / 1000),
    account_id: accountId,
  });
}

// ── Door state & control ──────────────────────────────────────────────────────

export type DoorState = 'open' | 'closed' | 'opening' | 'closing' | 'stopped' | 'unknown';

export async function getDoorState(serialNumber: string): Promise<DoorState | null> {
  const auth = await getAccessToken();
  if (!auth) return null;

  try {
    const res = await fetch(`${DEVICES_BASE}/api/v5.2/Accounts/${auth.accountId}/Devices`, {
      headers: { ...API_HEADERS, Authorization: `Bearer ${auth.token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;

    interface DevicesResp { items: Array<{ serial_number: string; state: { door_state?: string } }> }
    const data = await res.json() as DevicesResp;
    const device = data.items.find(d => d.serial_number === serialNumber);
    return (device?.state?.door_state ?? 'unknown') as DoorState;
  } catch {
    return null;
  }
}

export async function controlDoor(serialNumber: string, command: 'open' | 'close'): Promise<boolean> {
  const auth = await getAccessToken();
  if (!auth) return false;

  try {
    const res = await fetch(
      `${GDO_BASE}/api/v5.2/Accounts/${auth.accountId}/door_openers/${serialNumber}/${command}`,
      {
        method: 'PUT',
        headers: { ...API_HEADERS, Authorization: `Bearer ${auth.token}` },
        signal: AbortSignal.timeout(10000),
      },
    );
    return res.ok || res.status === 204;
  } catch {
    return false;
  }
}
