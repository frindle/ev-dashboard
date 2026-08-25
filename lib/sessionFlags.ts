import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

// Persisted session-level flags surfaced on the dashboard as banners.
// Kept small on purpose — this is a status board, not a queue.
export interface SessionFlags {
  tesla_reauth_required?: { at: number; reason: string };
  tesla_reauth_pushover_at?: number;

  // Sustained Fleet-API 403 storm — distinct from reauth. A 403 is an
  // authorization/entitlement refusal, NOT an expired token: it's raised by a
  // billing/usage-limit hit or a missing scope, neither of which re-running
  // OAuth fixes. We surface the raw status + body so it can be confirmed as a
  // billing limit vs. a genuine unauthorized before anyone re-auths.
  tesla_api_forbidden?: { at: number; status: number; body: string };

  rivian_reauth_due_soon?: { at: number; daysLeft: number };
  rivian_reauth_required?: { at: number; reason: string };
  rivian_reauth_pushover_at?: number;
  rivian_due_soon_pushover_at?: number;

  // OTA push-dedupe: last version we notified about, per vehicle.
  rivian_ota_notified_version?: string;
  tesla_ota_notified_version?: string;

  rivian_throttle_pushover_at?: number;

  rivian_api_error_pushover_at?: number;
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
  const before = JSON.stringify(f);
  fn(f);
  // Skip no-op writes. clearTeslaReauthRequired() now runs on every
  // successful Fleet API call, and rewriting an unchanged file on each poll
  // is both pointless disk churn and a wider window for a concurrent reader
  // to catch this (non-atomic) write half-done.
  if (JSON.stringify(f) !== before) writeFlags(f);
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

export function markTeslaApiForbidden(status: number, body: string): void {
  mutate(f => {
    if (f.tesla_api_forbidden) return; // keep the first observed reason
    f.tesla_api_forbidden = { at: Date.now(), status, body: body.slice(0, 300) };
    console.warn('[flags] tesla_api_forbidden set:', status, body.slice(0, 160));
  });
}

export function clearTeslaApiForbidden(): void {
  mutate(f => {
    if (f.tesla_api_forbidden) {
      delete f.tesla_api_forbidden;
      console.log('[flags] tesla_api_forbidden cleared');
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

export function shouldPushOtaOnce(vehicle: 'rivian' | 'tesla', version: string): boolean {
  const key = vehicle === 'tesla' ? 'tesla_ota_notified_version' : 'rivian_ota_notified_version';
  const f = readFlags();
  if (f[key] === version) return false;
  mutate(g => { g[key] = version; });
  return true;
}

// Rivian charge-throttle: unlike reauth (persisted until the underlying
// problem is fixed), isThrottled is re-derived live from vehicle state on
// every poll — push once when it starts, and the caller clears the dedup
// stamp once it stops, so the *next* throttle event pushes again too.
export function shouldPushThrottleOnce(): boolean {
  const f = readFlags();
  if (f.rivian_throttle_pushover_at) return false;
  mutate(g => { g.rivian_throttle_pushover_at = Date.now(); });
  return true;
}

export function clearRivianThrottleDedup(): void {
  mutate(f => {
    if (f.rivian_throttle_pushover_at) delete f.rivian_throttle_pushover_at;
  });
}

// Rivian API-fetch error streak (consecutive failures, throttle or not) —
// same one-push-per-lapse shape as the throttle dedup above: push once when
// the streak crosses the threshold, caller clears the stamp on the next
// success so the *next* streak pushes again too.
export function shouldPushApiErrorOnce(): boolean {
  const f = readFlags();
  if (f.rivian_api_error_pushover_at) return false;
  mutate(g => { g.rivian_api_error_pushover_at = Date.now(); });
  return true;
}

export function clearRivianApiErrorDedup(): void {
  mutate(f => {
    if (f.rivian_api_error_pushover_at) delete f.rivian_api_error_pushover_at;
  });
}
