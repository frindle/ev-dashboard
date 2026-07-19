import https from 'https';
import { readConfig } from '@/lib/config';

// Reolink's HTTP API — see api-docs/Reolink/api.md for the full reference
// this was built against. NVR feature is disabled (config.nvr.enabled) until
// there's actually an NVR recording to browse.

// Devices serve a self-signed cert on LAN. Node's global fetch (undici) doesn't
// honor a classic https.Agent for that, and undici isn't a project dependency
// here to use its dispatcher API — so these calls go through node:https directly,
// scoping the rejectUnauthorized bypass to just this file.
function postJson(url: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(url, {
      method: 'POST',
      rejectUnauthorized: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

interface TokenCache {
  token: string;
  expiresAt: number; // unix ms
}

let cache: TokenCache | null = null;

async function login(): Promise<string> {
  const { host, username, password } = readConfig().nvr;
  if (!host) throw new Error('NVR host not configured');

  const data = await postJson(`https://${host}/api.cgi?cmd=Login`, [{
    cmd: 'Login',
    param: { User: { Version: '0', userName: username, password } },
  }]) as Array<{ code: number; value?: { Token: { name: string; leaseTime: number } } }>;
  const result = data?.[0];
  if (result?.code !== 0) throw new Error(`Reolink login failed: ${JSON.stringify(result)}`);

  const token = result.value!.Token.name;
  const leaseTimeSec = result.value!.Token.leaseTime;
  cache = { token, expiresAt: Date.now() + (leaseTimeSec - 60) * 1000 };
  return token;
}

async function getToken(): Promise<string> {
  if (cache && cache.expiresAt > Date.now()) return cache.token;
  return login();
}

export interface DayStatus {
  year: number;
  mon: number;
  table: string; // one char per day of month, '1' = has recordings
}

export interface RecordingFile {
  name: string; // opaque source path — pass straight to buildPlaybackUrl/buildDownloadUrl
  size: number;
  start: string; // ISO
  end: string;   // ISO
}

function toApiTime(d: Date) {
  return {
    year: d.getFullYear(), mon: d.getMonth() + 1, day: d.getDate(),
    hour: d.getHours(), min: d.getMinutes(), sec: d.getSeconds(),
  };
}

function fromApiTime(t: { year: number; mon: number; day: number; hour: number; min: number; sec: number }): string {
  return new Date(t.year, t.mon - 1, t.day, t.hour, t.min, t.sec).toISOString();
}

interface SearchFile {
  name: string; size: number;
  StartTime: Parameters<typeof fromApiTime>[0];
  EndTime: Parameters<typeof fromApiTime>[0];
}

interface SearchResult {
  Status?: DayStatus[];
  File?: SearchFile[];
}

async function search(start: Date, end: Date, onlyStatus: 0 | 1): Promise<SearchResult> {
  const { host } = readConfig().nvr;
  const channel = readConfig().nvr.channel;
  const token = await getToken();

  const data = await postJson(`https://${host}/api.cgi?cmd=Search&token=${token}`, [{
    cmd: 'Search',
    action: 0,
    param: {
      Search: {
        channel, onlyStatus, streamType: 'main',
        StartTime: toApiTime(start), EndTime: toApiTime(end),
      },
    },
  }]) as Array<{ code: number; value?: { SearchResult: SearchResult } }>;
  const result = data?.[0];
  if (result?.code !== 0) throw new Error(`Reolink search failed: ${JSON.stringify(result)}`);
  return result.value!.SearchResult;
}

/** Cheap per-month calendar: which days have any recordings. */
export async function getMonthStatus(year: number, month: number): Promise<DayStatus[]> {
  const start = new Date(year, month - 1, 1, 0, 0, 0);
  const end = new Date(year, month, 0, 23, 59, 59); // last day of month
  const result = await search(start, end, 1);
  return result.Status ?? [];
}

/** Full clip listing for a single day. Keep the range to one day — wide ranges can time out. */
export async function getDayClips(year: number, month: number, day: number): Promise<RecordingFile[]> {
  const start = new Date(year, month - 1, day, 0, 0, 0);
  const end = new Date(year, month - 1, day, 23, 59, 59);
  const result = await search(start, end, 0);
  return (result.File ?? []).map(f => ({
    name: f.name,
    size: f.size,
    start: fromApiTime(f.StartTime),
    end: fromApiTime(f.EndTime),
  }));
}

/** Range-seekable URL — point a <video src> straight at this for playback. */
export async function buildPlaybackUrl(sourceName: string): Promise<string> {
  const { host } = readConfig().nvr;
  const token = await getToken();
  const encoded = encodeURIComponent(sourceName);
  return `https://${host}/cgi-bin/api.cgi?cmd=Playback&source=${encoded}&output=${encoded}&token=${token}`;
}
