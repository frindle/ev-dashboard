import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { readConfig } from '@/lib/config';
import { redactDashboardLocation } from '@/lib/vacation';

export const dynamic = 'force-dynamic';

export async function GET() {
  const dir = process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
  const path = join(dir, 'last-status.json');
  if (!existsSync(path)) return new Response(null, { status: 204 });
  try {
    const raw = readFileSync(path, 'utf-8');
    // Normally last-status.json is already redacted (the dashboard route
    // strips location before persisting while vacation mode is on). But right
    // after the switch is flipped ON, the file on disk may still hold the
    // pre-vacation coordinates until the next /api/dashboard poll rewrites it.
    // The client hits this cached endpoint first on load, so re-redact here
    // against the CURRENT config to guarantee no stale coords leak in that
    // window. When vacation mode is off this is a passthrough.
    if (!readConfig().vacationMode) {
      return new Response(raw, { headers: { 'Content-Type': 'application/json' } });
    }
    const redacted = redactDashboardLocation(JSON.parse(raw) as Record<string, unknown>);
    return new Response(JSON.stringify(redacted), { headers: { 'Content-Type': 'application/json' } });
  } catch {
    return new Response(null, { status: 204 });
  }
}
