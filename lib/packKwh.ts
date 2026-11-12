// Per-vehicle pack size (EV charge plan #6): the live batteryCapacity from the
// car when it reports one, else the configured packKwh, else the fallback.
export const RIVIAN_PACK_KWH_DEFAULT = 124.5;

const valid = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 20 && x <= 250;

export function packKwhFor(live: number | null | undefined, config: number | null | undefined, fallback: number): number {
  if (valid(live)) return live;
  if (valid(config)) return config;
  return fallback;
}
