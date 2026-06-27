# Vehicle card port plan

Compared the current `VehicleCard` in `app/page.tsx` (line ~97) against `docs/VEHICLE-CARD-DESIGN-2026-06-26.md`. The existing component is ~85% there — most of the markup, design tokens, and footer layout already match. The diffs below are the things that change.

## TL;DR

Existing component is more conservative on what to render and what control it offers, design adds richer location-aware badging + a mirrored grid trick for the stats. None of the diffs require a structural rewrite — every change is bounded to a few lines.

## What changes

### 1. Stats grid mirroring (functional change, not just visual)

**Now:** plain 2-column grid, content order is fixed in JSX (RANGE LEFT, ODOMETER, TARGET, CHARGE RATE).

**Design:** uses `grid-auto-flow: dense` + explicit `grid-column` on each cell so the **left card** (idx=0) puts RANGE LEFT + TARGET in column 2 (next to the dial), and the **right card** (idx=1) puts them in column 1 (also next to the dial). The result: range/target visually hug the dial on both sides.

Add these to the row builder:

```ts
const colInside  = isLeft ? 2 : 1;
const colOutside = isLeft ? 1 : 2;
```

And change the grid container to `gridAutoFlow: 'dense'`, then assign `gridColumn: colInside` to RANGE LEFT + TARGET, and `gridColumn: colOutside` to ODOMETER + CHARGE RATE.

### 2. Location-aware status badge

**Now:** four badge states — `DISCONNECTED`, `CHARGING`, `ASLEEP`, `IDLE`.

**Design:** four states keyed on `charging` + `atHome` — `CHARGING`, `CHARGING · AWAY`, `AWAY`, `IDLE`.

We have `atHome` already (computed in `app/api/dashboard/route.ts` via the home-radius check). Pass it through `VehicleData` and switch the badge logic to:

```ts
if      (chargingHome) badge = { label: 'CHARGING',        accent: true,  pulse: true  };
else if (charging)     badge = { label: 'CHARGING · AWAY', accent: true,  pulse: true  };
else if (!atHome)      badge = { label: 'AWAY',            accent: false, pulse: false };
else                   badge = { label: 'IDLE',            accent: false, pulse: false };
```

Keep `DISCONNECTED` + `ASLEEP` as overrides for when `v.connected === false` or `online === false` — design doesn't cover those states but they're real and worth surfacing.

### 3. ETA / status line in the footer

**Now:** `AT TARGET` / `PLUGGED IN · IDLE` / `NOT PLUGGED IN`, or the time-to-full when charging.

**Design:** richer cases:

```ts
etaLabel =
  chargingHome ? fmtEta(etaMin) :
  (!atHome && charging) ? `CHARGING AWAY · ${place}` :
  !atHome ? (speed > 0 ? `DRIVING ${speed} mph · ${place}` : `PARKED · ${place}`) :
  (soc >= limit ? 'AT TARGET' : 'IDLE · NOT PLUGGED IN');
```

Requires `place: string` and `speed: number` on `VehicleData`. We compute `atHome` already; need to add `place` (we have `nearestPlaceName` in the design discussion but I don't see it wired today — likely needs a small change in `lib/tesla.ts` / `lib/rivian.ts` to surface reverse-geocoded location).

### 4. Dial drag clamp

**Now:** check `app/page.tsx::ChargeDial::dialSet` for clamp range. Should already be 50..100 in 5% steps. **VERIFY** — design explicitly says `Math.max(50, Math.min(100, Math.round(pct / 5) * 5))`.

### 5. THROTTLED chip

The existing component renders a yellow `THROTTLED · {reason}` chip below the badge when `isThrottled && isCharging`. The design doesn't include this. **Keep it** — it's a real, useful state and design's a starting point, not a constraint.

### 6. Source caption

**Now:** `{limitNote} · DRAG DIAL · SOURCE {apiLabel}` — design matches.

## Not changing

- Card chrome (background, border, padding, gap) — already matches design tokens.
- Lock + AC buttons — visual identical, only Tesla can fire the commands today, which design also implies.
- Start/Stop button + Stop's transparent-border-trick to prevent layout jump.
- `SCHEDULE ONLY` chip for Rivian (`ctrl === 'schedule'`).

## Estimated effort

~30 minutes of code, all in `app/page.tsx` (no new file). Risk: the dial drag math is finicky — verify the limit tick lands exactly where the SVG expects after the change. Recommend doing it with the dashboard open in a browser and the Rivian + Tesla in known-good states.

## Suggested order when you're ready

1. Wire `place` + `speed` into `VehicleData` (server-side — `app/api/dashboard/route.ts` + lib/tesla / lib/rivian if not present).
2. Add `atHome`, `place`, `speed` to the card's prop or read from `s` directly.
3. Swap the badge logic to the chargingHome/away matrix.
4. Update the footer ETA expression.
5. Add the `colInside`/`colOutside` + `gridAutoFlow: 'dense'` mirroring.
6. Sanity-check the dial clamp range.
