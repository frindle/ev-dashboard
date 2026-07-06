import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

// Persisted session-level flags surfaced on the dashboard as banners.
// Kept small on purpose — this is a status board, not a queue.
export interface SessionFlags {
  tesla_reauth_required?: { at: number; reason: string };
  tesla_reauth_pushover_at?: number;

  rivian_reauth_due_soon?: { at: number; daysLeft: number };
  rivian_reauth_required?: { at: number; reason: string };
  rivian_reauth_pushover_at?: number;
  rivian_due_soon_pushover_at?: number;

  // Rivian OTA push-dedupe: last version we notified about.
  rivian_ota_notified_version?: string;
}

function flagsPath(): string {
  const dir = process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
  return join(dir, 'session-flags.json');
}

export function readFlags(): SessionFlags {
  const p = flagsPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as SessionFlags;
  } catch {
    return {};
  }
}

export function writeFlags(f: SessionFlags): void {
  try {
    writeFileSync(flagsPath(), JSON.stringify(f, null, 2));
  } catch (e) {
    console.warn('[flags] persist failed:', String(e).slice(0, 120));
  }
}

function mutate(fn: (f: SessionFlags) => void): void {
  const f = readFlags();
  fn(f);
  writeFlags(f);
}

// ── Tesla ─────────────────────────────────────────────────────────────────

export function markTeslaReauthRequired(reason: string): void {
  mutate(f => {
    if (f.tesla_reauth_required) return; // don't overwrite the original reason
    f.tesla_reauth_required = { at: Date.now(), reason };
    console.warn('[flags] tesla_reauth_required set:', reason);
  });
}

export function clearTeslaReauthRequired(): void {
  mutate(f => {
    if (f.tesla_reauth_required || f.tesla_reauth_pushover_at) {
      delete f.tesla_reauth_required;
      delete f.tesla_reauth_pushover_at;
      console.log('[flags] tesla_reauth_required cleared');
    }
  });
}

// ── Rivian ────────────────────────────────────────────────────────────────

export function markRivianReauthRequired(reason: string): void {
  mutate(f => {
    if (f.rivian_reauth_required) return;
    f.rivian_reauth_required = { at: Date.now(), reason };
    console.warn('[flags] rivian_reauth_required set:', reason);
  });
}

export function markRivianReauthDueSoon(daysLeft: number): void {
  mutate(f => {
    if (f.rivian_reauth_due_soon && f.rivian_reauth_due_soon.daysLeft <= daysLeft) return;
    f.rivian_reauth_due_soon = { at: Date.now(), daysLeft };
  });
}

export function clearRivianReauthFlags(): void {
  mutate(f => {
    delete f.rivian_reauth_required;
    delete f.rivian_reauth_due_soon;
    delete f.rivian_reauth_pushover_at;
    delete f.rivian_due_soon_pushover_at;
    console.log('[flags] rivian_reauth flags cleared');
  });
}

// Returns true if we should push; also stamps the last-push time so the
// caller doesn't have to re-read.
export function shouldPushOncePerLapse(key: 'tesla' | 'rivian'): boolean {
  const f = readFlags();
  const stampKey = key === 'tesla' ? 'tesla_reauth_pushover_at' : 'rivian_reauth_pushover_at';
  if (f[stampKey]) return false;
  mutate(g => { g[stampKey] = Date.now(); });
  return true;
}

// One push per lapse for the day-83 "session expiring soon" warning.
// Cleared alongside the other Rivian flags on successful re-login.
export function shouldPushDueSoonOnce(): boolean {
  const f = readFlags();
  if (f.rivian_due_soon_pushover_at) return false;
  mutate(g => { g.rivian_due_soon_pushover_at = Date.now(); });
  return true;
}

export function shouldPushOtaOnce(version: string): boolean {
  const f = readFlags();
  if (f.rivian_ota_notified_version === version) return false;
  mutate(g => { g.rivian_ota_notified_version = version; });
  return true;
}
