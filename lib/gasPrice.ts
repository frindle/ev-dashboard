// lib/gasPrice.ts
// Live gasoline price for the fuel-savings tile. Split out from lib/rates.ts
// so that module stays dependency-free and directly runnable by
// scripts/check-rates.ts.

import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { readConfig } from '@/lib/config';
import { logError } from '@/lib/logger';

// ─────────────────────────────────────────────────────────────
// Gasoline price — EIA API v2
// ─────────────────────────────────────────────────────────────
//
// EIA does NOT publish a weekly retail gasoline series for Nevada — verified
// 2026-08-01 by listing the `duoarea` facet of the petroleum/pri/gnd route:
// the only states covered weekly are CA, CO, FL, MA, MN, NY, OH, TX and WA.
// The closest published weekly series covering Nevada is PADD 5 excluding
// California, which is the region Nevada sits in and excludes California's
// outlier prices:
//   EMM_EPMR_PTE_R5XCA_DPG
//   "West Coast (PADD 5) Except California Regular All Formulations Retail
//    Gasoline Prices (Dollars per Gallon)"
const EIA_GND_URL = 'https://api.eia.gov/v2/petroleum/pri/gnd/data/';
const EIA_DUOAREA = 'R5XCA';
export const GAS_PRICE_LABEL = 'EIA weekly · PADD 5 ex-CA regular';

// EIA publishes this once a week (Mondays), so there is no point fetching it
// more than daily. Same spirit as lib/tesla.ts's smart-poll: cache to disk so
// the cadence survives container restarts, and keep serving a stale value if
// the refresh fails rather than blanking the tile.
const GAS_PRICE_CACHE_FILE = 'gas-price.json';
const GAS_PRICE_TTL_MS = 24 * 60 * 60 * 1000;

interface GasPriceCache { usdPerGallon: number; period: string; fetchedAt: number; }

function gasPriceCachePath(): string {
  const dir = process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
  return join(dir, GAS_PRICE_CACHE_FILE);
}

export async function fetchGasPriceUsdPerGallon(): Promise<{ usdPerGallon: number; period: string } | null> {
  const path = gasPriceCachePath();
  let cache: GasPriceCache | null = null;
  if (existsSync(path)) {
    try { cache = JSON.parse(await readFile(path, 'utf-8')) as GasPriceCache; } catch { /* refetch */ }
  }
  if (cache && Date.now() - cache.fetchedAt < GAS_PRICE_TTL_MS) {
    return { usdPerGallon: cache.usdPerGallon, period: cache.period };
  }

  const apiKey = readConfig().eia.apiKey;
  if (!apiKey) return cache ? { usdPerGallon: cache.usdPerGallon, period: cache.period } : null;

  try {
    const url = new URL(EIA_GND_URL);
    url.searchParams.set('api_key', apiKey);
    url.searchParams.set('frequency', 'weekly');
    url.searchParams.set('data[0]', 'value');
    url.searchParams.set('facets[duoarea][]', EIA_DUOAREA);
    url.searchParams.set('facets[product][]', 'EPMR');  // regular gasoline
    url.searchParams.set('facets[process][]', 'PTE');   // retail sales
    url.searchParams.set('sort[0][column]', 'period');
    url.searchParams.set('sort[0][direction]', 'desc');
    url.searchParams.set('length', '1');

    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`EIA ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const body = await res.json() as { response?: { data?: Array<{ period: string; value: string }> } };
    const row = body.response?.data?.[0];
    const usdPerGallon = Number(row?.value);
    if (!row || !Number.isFinite(usdPerGallon) || usdPerGallon <= 0) throw new Error('EIA returned no usable row');

    const fresh: GasPriceCache = { usdPerGallon, period: row.period, fetchedAt: Date.now() };
    await writeFile(path, JSON.stringify(fresh)).catch(() => null);
    return { usdPerGallon, period: row.period };
  } catch (e) {
    console.error('[gas-price] EIA fetch failed:', e);
    void logError('gas-price', e);
    // Stale beats blank.
    return cache ? { usdPerGallon: cache.usdPerGallon, period: cache.period } : null;
  }
}
