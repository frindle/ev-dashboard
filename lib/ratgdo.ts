import { readConfig } from './config';

// Ratgdo runs stock ESPHome with its Web Server API component enabled --
// GET http://<ip>/cover/<entity> returns JSON like
// {"id":"cover-...", "state":"OPEN"|"CLOSED"|..., ...}. See
// https://esphome.io/web-api/ and
// https://ratgdo.github.io/esphome-ratgdo/webui_documentation.html.
// Device isn't installed yet, so the entity name is a configurable guess
// (default "garage_door") rather than hardcoded -- a one-field admin fix
// if the real device reports something else.
export type GarageDoorState = 'open' | 'closed' | 'unknown';

export async function readGarageDoorState(): Promise<GarageDoorState | null> {
  const cfg = readConfig().garageDoor;
  if (!cfg?.url) return null; // not configured -- caller should hide the UI entirely

  try {
    const res = await fetch(`${cfg.url.replace(/\/$/, '')}/cover/${cfg.entity || 'garage_door'}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return 'unknown';
    const data = await res.json() as { state?: string };
    const state = (data.state ?? '').toUpperCase();
    if (state === 'OPEN') return 'open';
    if (state === 'CLOSED') return 'closed';
    return 'unknown';
  } catch {
    // Device unreachable/offline -- not configured yet, or just off the LAN
    // right now. Either way, this must not take the dashboard down with it.
    return 'unknown';
  }
}
