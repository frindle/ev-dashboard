// Single source of truth for the shared-circuit banner state.
// Charging means current is actually flowing (amps > 0) — a plugged-in car at
// its charge limit or on a schedule draws 0 A and must NOT read as charging.

export function circuitStatus(
  leftAmps: number,
  rightAmps: number,
  leftPlugged: boolean,
  rightPlugged: boolean,
): { label: string; charging: boolean } {
  const chargingCount = (leftAmps > 0 ? 1 : 0) + (rightAmps > 0 ? 1 : 0);
  const pluggedCount = (leftPlugged ? 1 : 0) + (rightPlugged ? 1 : 0);
  const label =
    chargingCount === 2 ? 'BOTH CHARGING — WITHIN CIRCUIT LIMIT'
    : chargingCount === 1 ? 'ONE CONNECTOR CHARGING — WITHIN CIRCUIT LIMIT'
    : pluggedCount === 2 ? 'BOTH PLUGGED IN — NOT CHARGING'
    : pluggedCount === 1 ? 'PLUGGED IN — NOT CHARGING'
    : 'IDLE — NOTHING CHARGING';
  return { label, charging: chargingCount > 0 };
}
