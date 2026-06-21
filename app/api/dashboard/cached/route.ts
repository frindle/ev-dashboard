import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export const dynamic = 'force-dynamic';

export async function GET() {
  const dir = process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
  const path = join(dir, 'last-status.json');
  if (!existsSync(path)) return new Response(null, { status: 204 });
  try {
    const raw = readFileSync(path, 'utf-8');
    return new Response(raw, { headers: { 'Content-Type': 'application/json' } });
  } catch {
    return new Response(null, { status: 204 });
  }
}
