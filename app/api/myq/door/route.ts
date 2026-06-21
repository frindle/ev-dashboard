import { getDoorState, controlDoor } from '@/lib/myq';
import { readConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET() {
  const cfg = readConfig();
  const serial = cfg.garage.deviceSerial;
  if (!serial) return Response.json({ error: 'No device serial configured' }, { status: 400 });
  const state = await getDoorState(serial);
  if (state === null) return Response.json({ error: 'Could not fetch door state' }, { status: 502 });
  return Response.json({ state });
}

export async function POST(req: Request) {
  const { command } = await req.json() as { command?: 'open' | 'close' };
  if (command !== 'open' && command !== 'close') {
    return Response.json({ error: 'Command must be open or close' }, { status: 400 });
  }
  const cfg = readConfig();
  const serial = cfg.garage.deviceSerial;
  if (!serial) return Response.json({ error: 'No device serial configured' }, { status: 400 });
  const ok = await controlDoor(serial, command);
  return Response.json({ ok });
}
