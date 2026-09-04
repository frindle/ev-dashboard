import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { readConfig, writeConfig } from './config';

// Background sync: mirror the ecobee thermostat's Vacation state (surfaced by
// Home Assistant as climate.<entity>.preset_mode === "vacation") onto the
// dashboard's existing Vacation Mode privacy switch. HA owns the ecobee OAuth;
// this only READS one entity from HA's REST API and edge-toggles vacationMode.
//
// EDGE-TRIGGERED on purpose: we write config ONLY when the ecobee vacation
// state changes (or on first run, to align to reality once). Between ecobee
// transitions we never touch vacationMode, so the admin panel's manual toggle
// still works — e.g. you can hide location manually without being on vacation,
// and we won't clobber it every poll. Level-triggering would make the manual
// toggle useless.
//
// Config via env (loaded from the container's .env via docker-compose env_file):
//   HA_URL             e.g. http://10.0.9.10:8123   (required)
//   HA_TOKEN           a HA long-lived access token  (required)
//   HA_ECOBEE_ENTITY   default "climate.upstairs"
//   HA_VACATION_PRESET default "vacation"
// Missing HA_URL/HA_TOKEN => this is a no-op (feature simply off), never an error.

const STATE_FILE = '.ecobee-sync.json';

function statePath(): string {
  const dir = process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
  return join(dir, STATE_FILE);
}

interface SyncState {
  lastVacation?: boolean;   // undefined until the first successful poll
  lastPreset?: string;
  ts?: string;
}

function readState(): SyncState {
  try {
    const p = statePath();
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, 'utf-8')) as SyncState;
  } catch {
    return {};
  }
}

function writeState(s: SyncState): void {
  try {
    writeFileSync(statePath(), JSON.stringify(s, null, 2));
  } catch {
    // best-effort; a lost state file just means one extra align on next boot
  }
}

export interface SyncResult {
  skipped?: string;
  preset?: string;
  vacation?: boolean;
  changed?: boolean;
  error?: string;
}

export async function syncEcobeeVacation(): Promise<SyncResult> {
  const base = process.env.HA_URL;
  const token = process.env.HA_TOKEN;
  if (!base || !token) return { skipped: 'HA_URL/HA_TOKEN not set' };

  const entity = process.env.HA_ECOBEE_ENTITY || 'climate.upstairs';
  const vacPreset = process.env.HA_VACATION_PRESET || 'vacation';

  let preset: string | undefined;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const res = await fetch(`${base.replace(/\/$/, '')}/api/states/${entity}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return { error: `HA ${res.status} for ${entity}` };
    const body = await res.json() as { attributes?: { preset_mode?: string } };
    preset = body?.attributes?.preset_mode;
  } catch (e) {
    // HA unreachable / timeout — leave vacationMode untouched, try again next tick
    return { error: `HA fetch failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const isVacation = preset === vacPreset;
  const prev = readState();

  // No change since last successful poll: don't touch config (preserves the
  // manual toggle between ecobee transitions). Still refresh lastPreset.
  if (prev.lastVacation === isVacation) {
    if (prev.lastPreset !== preset) {
      writeState({ ...prev, lastPreset: preset, ts: new Date().toISOString() });
    }
    return { preset, vacation: isVacation, changed: false };
  }

  // Transition (or first run): align vacationMode to ecobee, once.
  const cfg = readConfig();
  if (cfg.vacationMode !== isVacation) {
    writeConfig({ ...cfg, vacationMode: isVacation });
  }
  writeState({ lastVacation: isVacation, lastPreset: preset, ts: new Date().toISOString() });
  console.log(`[ecobee-sync] ${entity} preset=${preset} -> vacationMode=${isVacation}`);
  return { preset, vacation: isVacation, changed: true };
}
