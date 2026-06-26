import { NextRequest } from 'next/server';
import { readConfig } from '@/lib/config';
import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import {
  wakeVehicle,
  setChargeLimit,
  startCharging,
  stopCharging,
  lockDoors,
  unlockDoors,
  startClimate,
  stopClimate,
  type TeslaVehicleState,
} from '@/lib/tesla';

export const dynamic = 'force-dynamic';

// Tesla returns success on set_charge_limit but our cached vehicle_data
// snapshot keeps the old value until the next poll — which can be 5 min
// out if the car is awake/parked. The slider snaps back to the stale
// value during that window, looking like the command failed. We
// optimistically patch the cache with the new value the moment Tesla
// confirms the change, so the next dashboard render shows it.
async function patchTeslaCache(patch: Partial<TeslaVehicleState>): Promise<void> {
  try {
    const dir = process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
    const path = join(dir, 'tesla-state.json');
    if (!existsSync(path)) return;
    const raw = JSON.parse(await readFile(path, 'utf-8')) as { state: TeslaVehicleState; fetchedAt: number; source?: string };
    raw.state = { ...raw.state, ...patch };
    raw.fetchedAt = Date.now();
    await writeFile(path, JSON.stringify(raw));
  } catch { /* non-fatal */ }
}

type CommandName =
  | 'wake'
  | 'charge_start'
  | 'charge_stop'
  | 'set_charge_limit'
  | 'lock'
  | 'unlock'
  | 'climate_start'
  | 'climate_stop';

export async function POST(req: NextRequest) {
  try {
    const { command, params } = await req.json() as { command: CommandName; params?: Record<string, unknown> };
    const cfg = readConfig();
    const vin = cfg.vehicles.tesla.vin;

    let result = false;
    switch (command) {
      case 'wake':
        result = await wakeVehicle(vin);
        break;
      case 'charge_start':
        result = await startCharging(vin);
        break;
      case 'charge_stop':
        result = await stopCharging(vin);
        break;
      case 'set_charge_limit': {
        const percent = params?.percent as number;
        result = await setChargeLimit(vin, percent);
        if (result) await patchTeslaCache({ chargeLimit: percent });
        break;
      }
      case 'lock':
        result = await lockDoors(vin);
        break;
      case 'unlock':
        result = await unlockDoors(vin);
        break;
      case 'climate_start':
        result = await startClimate(vin);
        break;
      case 'climate_stop':
        result = await stopClimate(vin);
        break;
      default:
        return Response.json({ error: 'Unknown command' }, { status: 400 });
    }

    return Response.json({ result });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
