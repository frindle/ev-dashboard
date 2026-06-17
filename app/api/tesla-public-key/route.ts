import { readFileSync } from 'fs';
import { join } from 'path';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const keyPath = process.env.KEYS_DIR
      ? join(process.env.KEYS_DIR, 'public-key.pem')
      : join(process.cwd(), 'keys', 'public-key.pem');
    const key = readFileSync(keyPath, 'utf-8');
    return new Response(key, {
      headers: { 'Content-Type': 'application/x-pem-file' },
    });
  } catch {
    return new Response('Public key not found', { status: 404 });
  }
}
