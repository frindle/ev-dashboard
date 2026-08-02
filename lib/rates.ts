// lib/rates.ts
// Cost inputs for the fuel-savings tile: NV Energy time-of-use electricity
// rates and comparable gas-vehicle MPG figures. The live gasoline price lives
// in lib/gasPrice.ts -- this module is deliberately dependency-free so
// scripts/check-rates.ts can run it directly under plain Node.
//
// UTILITY RATES CHANGE ROUGHLY ANNUALLY — the tables below are the only
// place they're defined. Update them here (and bump RATE_SCHEDULE_LABEL)
// when a new schedule takes effect; nothing else needs to change.

// ─────────────────────────────────────────────────────────────
// Electricity — NV Energy Southern Nevada residential TOU
// ─────────────────────────────────────────────────────────────
//
// Source: NV Energy Southern Nevada Residential rate schedule
// (ORS-TOU / EVRR), effective January 1, 2026.
//
// Time-of-use periods:
//   EVRR window   — 12:01 a.m. to 8:00 a.m. daily, every season (the cheap
//                   overnight EV charging rate).
//   Summer        — June 1 through September 30.
//     on-peak     — 6:01 p.m. to 9:00 p.m. daily.
//     off-peak    — every other summer hour outside the EVRR window.
//   Winter        — October through May, all hours outside the EVRR window.

export const RATE_SCHEDULE_LABEL = 'NV Energy S. NV Residential ORS-TOU/EVRR · eff. 2026-01-01';

/** Base per-kWh electric consumption component, by TOU bucket. */
const BASE_RATE_USD_PER_KWH = {
  winter:         0.08816,
  winterEvrr:     0.07965,
  summerOnPeak:   0.47313,
  summerOffPeak:  0.07463,
  summerEvrr:     0.06747,
} as const;

export type TouBucket = keyof typeof BASE_RATE_USD_PER_KWH;

// Flat per-kWh riders that apply to every bucket regardless of TOU period.
// DEAA 0.00000, TRED 0.00053, REPR -0.00052, EE 0.00237, NDPP 0.00029,
// ESAP 0.00007  → net +0.00274/kWh.
const RIDERS_USD_PER_KWH = 0.00000 + 0.00053 - 0.00052 + 0.00237 + 0.00029 + 0.00007;
// Universal Energy Charge, also flat per kWh.
const UNIVERSAL_ENERGY_CHARGE_USD_PER_KWH = 0.00039;

// APPROXIMATION: the 5% Clark County local government fee is actually applied
// to the whole bill subtotal — which includes a flat monthly basic service
// charge this module deliberately ignores, since a single charging session
// has no meaningful share of it. Modelling the fee as a flat multiplier on
// the per-kWh energy cost is close enough for an estimate tile but is NOT
// how the bill is really computed. Do not treat this output as exact billing.
const CLARK_COUNTY_FEE_MULTIPLIER = 1.05;

/** Which TOU bucket a given local wall-clock moment falls into. */
export function touBucketFor(d: Date): TouBucket {
  const month = d.getMonth() + 1;              // 1-12
  const hour = d.getHours();                   // 0-23, local
  const isSummer = month >= 6 && month <= 9;   // Jun 1 – Sep 30
  // EVRR runs 12:01a–8:00a. Hours 0 through 7 sit inside that window; the
  // one-minute edges (12:00-12:01a, 8:00-8:01a) aren't worth modelling.
  const isEvrr = hour < 8;
  if (isEvrr) return isSummer ? 'summerEvrr' : 'winterEvrr';
  if (!isSummer) return 'winter';
  // Summer on-peak is 6:01p–9:00p, i.e. the 18:00, 19:00 and 20:00 hours.
  return hour >= 18 && hour < 21 ? 'summerOnPeak' : 'summerOffPeak';
}

/** All-in delivered $/kWh for a TOU bucket, riders + county fee included. */
export function ratePerKwh(bucket: TouBucket): number {
  const base = BASE_RATE_USD_PER_KWH[bucket] + RIDERS_USD_PER_KWH + UNIVERSAL_ENERGY_CHARGE_USD_PER_KWH;
  return base * CLARK_COUNTY_FEE_MULTIPLIER;
}

/**
 * TOU-aware cost of one charging session.
 *
 * We only record a session's start/end timestamps and its total kWh, not a
 * power curve, so energy is allocated to each clock hour in proportion to the
 * minutes the session spent in it (i.e. assumes steady power). Sessions that
 * straddle a TOU boundary — the common overnight EVRR case — therefore get
 * split across buckets rather than billed entirely at the start-time rate.
 */
export function sessionElectricityCostUsd(startMs: number, endMs: number, kwh: number): number {
  if (!(kwh > 0)) return 0;
  const durationMs = endMs - startMs;
  // Zero/negative/absurd duration: fall back to the start hour's rate.
  if (!(durationMs > 0)) return kwh * ratePerKwh(touBucketFor(new Date(startMs)));

  let cost = 0;
  let cursor = startMs;
  while (cursor < endMs) {
    // End of the clock hour `cursor` sits in (local time).
    const hourEnd = new Date(cursor);
    hourEnd.setMinutes(60, 0, 0);
    const sliceEnd = Math.min(hourEnd.getTime(), endMs);
    const share = (sliceEnd - cursor) / durationMs;
    cost += kwh * share * ratePerKwh(touBucketFor(new Date(cursor)));
    cursor = sliceEnd;
  }
  return cost;
}

// ─────────────────────────────────────────────────────────────
// Comparable gas vehicles
// ─────────────────────────────────────────────────────────────
//
// EPA combined MPG for the gas car each EV is being compared against.
// All figures pulled live from fueleconomy.gov's public API on 2026-08-01
// (ws/rest/vehicle/{id}, `comb08` field) — edit freely if you'd rather
// compare against something else.
export const COMPARABLES = {
  rivian: {
    // Rivian R1S: 3-row, ~7,000 lb, AWD. The 2026 Jeep Grand Cherokee L 4WD
    // with the 3.6 V6 (fueleconomy.gov id 50162, 21 mpg combined) is the
    // closest match on size, seating and drivetrain. A Toyota Highlander AWD
    // (id 50132, 24 mpg combined) was the other candidate but its 2.4L
    // 4-cylinder turbo is a much lighter, lower-output vehicle — using it
    // would understate the comparison.
    comparable: '2026 Jeep Grand Cherokee L 4WD 3.6 V6',
    mpg: 21,
    packKwh: 135,
  },
  tesla: {
    // Tesla Model 3: compact sport sedan. The 2026 Mazda 3 4-Door 2WD 2.5L
    // (fueleconomy.gov id 49256, 30 mpg combined) is the pick. The 2026 VW
    // Jetta 1.5T (id 49269, 34 mpg combined) was the other candidate and has
    // equally clean current-year data, but its economy-tuned 1.5T is an
    // outlier on output for the class — the Mazda 3's naturally aspirated
    // 2.5L is much closer to the Model 3 on curb weight and performance, so
    // it's the more defensible comparable.
    comparable: '2026 Mazda 3 4-Door 2WD 2.5L',
    mpg: 30,
    packKwh: 82,
  },
} as const;

export type VehicleId = keyof typeof COMPARABLES;
