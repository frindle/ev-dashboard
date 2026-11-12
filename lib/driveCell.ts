// Map cells for repeat-route matching (EV charge plan #6/#8). A cell is a
// ~600 m grid square; only an HMAC of its id with a local secret salt is ever
// stored, so the jsonl can match "same place" without holding a place.
import { createHmac } from 'node:crypto';

const CELL_M = 600;
const M_PER_DEG_LAT = 111_320;

// Grid id of a position; deterministic, in memory only.
export function cellId(lat: number, lon: number): string {
  const dLat = CELL_M / M_PER_DEG_LAT;
  const iy = Math.floor(lat / dLat);
  const midLat = (iy + 0.5) * dLat;
  const dLon = CELL_M / (M_PER_DEG_LAT * Math.max(0.01, Math.cos((midLat * Math.PI) / 180)));
  const ix = Math.floor(lon / dLon);
  return `${iy}:${ix}`;
}

export function hashCell(salt: Buffer | string, lat: number, lon: number): string {
  return createHmac('sha256', salt).update(cellId(lat, lon)).digest('hex').slice(0, 24);
}
