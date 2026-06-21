import { NextRequest } from 'next/server';
import { readConfig } from '@/lib/config';
import {
  wakeVehicle,
  setChargeLimit,
  startCharging,
  stopCharging,
  lockDoors,
  unlockDoors,
  startClimate,
  stopClimate,
} from '@/lib/tesla';

export const dynamic = 'force-dynamic';

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
      case 'set_charge_limit':
        result = await setChargeLimit(vin, params?.percent as number);
        break;
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
