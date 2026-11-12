// Holds one parsed upload in memory between the preview and the confirm click,
// so the raw file never touches disk. Entries expire after 20 minutes.
import { randomBytes } from 'node:crypto';
import type { NveAccumulator } from './nveImport.ts';

const TTL_MS = 20 * 60_000;
const MAX_ENTRIES = 3;
const store = new Map<string, { acc: NveAccumulator; at: number }>();

function sweep(now: number) {
  for (const [k, v] of store) if (now - v.at > TTL_MS) store.delete(k);
  while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value as string);
}

export function holdUpload(acc: NveAccumulator, now = Date.now()): string {
  sweep(now);
  const token = randomBytes(12).toString('hex');
  store.set(token, { acc, at: now });
  sweep(now);
  return token;
}

export function takeUpload(token: string, now = Date.now()): NveAccumulator | null {
  sweep(now);
  const v = store.get(token);
  return v ? v.acc : null;
}

export function dropUpload(token: string) { store.delete(token); }
