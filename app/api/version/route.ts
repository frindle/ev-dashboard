import { version } from '@/package.json';
import { readFileSync } from 'fs';

export const dynamic = 'force-dynamic';

// Ported from resell-tracker's /api/version — same self-hosted Docker
// rebuild-from-source deploy model, so the same BUILD_SHA-vs-main-commit
// comparison applies. See docker-compose.yml build.args.BUILD_SHA and
// Dockerfile ARG BUILD_SHA / .build-time fallback for the write side.

interface VersionResponse {
  version: string;
  current: string;
  latest: string | null;
  outdated: boolean;
}

export async function GET() {
  const current = (process.env.BUILD_SHA ?? '').trim() || 'unknown';

  try {
    const res = await fetch('https://api.github.com/repos/frindle/ev-dashboard/commits/main', {
      headers: { 'User-Agent': 'ev-dashboard', Accept: 'application/vnd.github+json' },
      next: { revalidate: 300 },
    });
    if (!res.ok) {
      return Response.json({ version, current, latest: null, outdated: false } satisfies VersionResponse);
    }
    const data = await res.json() as { sha?: string; commit?: { committer?: { date?: string } } };
    const latest = (data.sha ?? '').slice(0, 7) || null;
    let outdated = current !== 'unknown' && latest !== null && current !== latest && !latest.startsWith(current);
    if (current === 'unknown' && latest !== null) {
      try {
        const builtAt = Date.parse(readFileSync(process.cwd() + '/.build-time', 'utf8').trim());
        const committedAt = Date.parse(data.commit?.committer?.date ?? '');
        if (!isNaN(builtAt) && !isNaN(committedAt)) {
          outdated = committedAt > builtAt + 5 * 60 * 1000;
        }
      } catch { /* no .build-time in image — stay non-outdated */ }
    }
    return Response.json({ version, current, latest, outdated } satisfies VersionResponse);
  } catch {
    return Response.json({ version, current, latest: null, outdated: false } satisfies VersionResponse);
  }
}
