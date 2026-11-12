import { NextResponse } from 'next/server';
import { readChargeHistory } from '@/lib/chargeHistory';
import { influxTarget, writeLines } from '@/lib/chargeSessionInflux';
import {
  dailyPeakLines, dailyPeaks, intervalLines, intervalMinutes, sessionSpans, sortedIntervals,
} from '@/lib/nveImport';
import { dropUpload, takeUpload } from '@/lib/nveUploadStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Step 2: write the held upload to Influx as nve_interval and nve_daily_peak.
// Same measurement + tags + timestamp overwrite, so uploading again is safe.
export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as { token?: string } | null;
  const acc = body?.token ? takeUpload(body.token) : null;
  if (!acc) return NextResponse.json({ error: 'That upload has expired. Choose the files again.' }, { status: 410 });
  const target = influxTarget();
  if (!target) return NextResponse.json({ error: 'InfluxDB is not configured (INFLUX_URL, INFLUX_TOKEN, INFLUX_ORG, INFLUX_BUCKET).' }, { status: 503 });

  const list = sortedIntervals(acc);
  const spans = sessionSpans(await readChargeHistory());
  const peaks = dailyPeaks(list, intervalMinutes(acc), spans);
  try {
    const intervals = await writeLines(intervalLines(list), target);
    const days = await writeLines(dailyPeakLines(peaks), target);
    dropUpload(body!.token!);
    return NextResponse.json({ intervals, days, chargeSessionsUsed: spans.length });
  } catch (e) {
    return NextResponse.json({ error: 'Influx write failed: ' + (e instanceof Error ? e.message : 'unknown error') }, { status: 502 });
  }
}
