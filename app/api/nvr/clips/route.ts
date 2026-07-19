import { NextRequest } from 'next/server';
import { readConfig } from '@/lib/config';
import { getMonthStatus, getDayClips, buildPlaybackUrl } from '@/lib/reolink';

export const dynamic = 'force-dynamic';

// GET /api/nvr/clips?year=2026&month=7          -> DayStatus[] (calendar bitmap)
// GET /api/nvr/clips?year=2026&month=7&day=21   -> clips for that day, with playback URLs
export async function GET(req: NextRequest) {
  if (!readConfig().nvr.enabled) {
    return Response.json({ error: 'NVR not enabled' }, { status: 404 });
  }

  const year = parseInt(req.nextUrl.searchParams.get('year') ?? '', 10);
  const month = parseInt(req.nextUrl.searchParams.get('month') ?? '', 10);
  const dayParam = req.nextUrl.searchParams.get('day');

  if (!year || !month) {
    return Response.json({ error: 'year and month are required' }, { status: 400 });
  }

  try {
    if (!dayParam) {
      const status = await getMonthStatus(year, month);
      return Response.json({ status });
    }

    const day = parseInt(dayParam, 10);
    const files = await getDayClips(year, month, day);
    const clips = await Promise.all(files.map(async f => ({
      ...f,
      playbackUrl: await buildPlaybackUrl(f.name),
    })));
    return Response.json({ clips });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
