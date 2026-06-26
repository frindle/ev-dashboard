# Tesla → garage door — research + recommendation

Date: 2026-06-26
Original ask: "Tesla → MyQ backdoor research."

## TL;DR — there's no MyQ backdoor we need

Tesla exposes a Fleet API command, `POST /api/1/vehicles/{vin}/command/trigger_homelink`, that triggers the **car's built-in HomeLink RF transmitter** — which is exactly the signal a standard remote sends. It works on any HomeLink-paired door, including MyQ-equipped openers, because at the protocol layer it's the same 315 MHz / 433 MHz RF that the original handheld remote uses.

So we don't need MyQ API access at all. We don't need MyQ credentials. We don't even need a MyQ subscription. The car opens its own door.

## Why this matters now

You already have MyQ wired up in the EV dashboard (`config.garage`, `app/api/myq/door`). MyQ has been actively breaking third-party API access — Home Assistant, HomeKit, and most community projects keep getting throttled or blocked. The MyQ path is brittle long-term.

The HomeLink path is on Tesla's side, which we already have working (Fleet API + telemetry + virtual key pairing in flight).

## Constraints worth knowing before we wire it up

1. **The car has to be in HomeLink RF range.** ~50 ft / 15 m line-of-sight is typical. If the car is parked outside the radius or off-site, the command silently no-ops on the car (no error from the API). Practically this means we can only trigger when the car is in the driveway or just down the street.

2. **One-time HomeLink pairing at the car.** The garage door has to be paired to the car's HomeLink module once, the normal way — hold down a HomeLink button while pressing the original remote until the indicator confirms. This is a vehicle-side action, not API-driven.

3. **Virtual key pairing required.** `trigger_homelink` is a command (not a read), so it goes through the signed-command path — needs the same BLE-at-the-car virtual key pairing that we already have on the TODO list (`https://tesla.com/_ak/ev-dashboard.penndalton.com`).

4. **HomeLink doesn't expose state.** We can fire "trigger" but we can't read "open/closed" — HomeLink is one-way. To know whether the door is actually open afterward, we'd still want either MyQ status polling OR a magnetic reed sensor / Zigbee tilt sensor wired into Unraid.

5. **Not all cars equipped.** `trigger_homelink` errors `not_supported` on vehicles without HomeLink. Model 3 Performance / certain base trims sometimes ship without it. Confirm via the touchscreen → Controls → HomeLink. If the icon is there, the API will work.

## Recommendation

**Add `trigger_homelink` as a fallback path** alongside the existing MyQ integration:

- Primary command path: HomeLink via Tesla Fleet API. No cloud round-trips through MyQ → less latency, no broken-third-party-API risk.
- State path: keep MyQ (or migrate to a tilt sensor later). HomeLink can't tell us whether the door actually opened.
- If the Tesla isn't home (we already compute `atHome` from GPS), gracefully fall through to MyQ — which can talk to the opener over its own LAN/cloud path even when the car is away.

Concretely:
- New `POST /api/garage/homelink` route in ev-dashboard that calls Tesla's `trigger_homelink` for the configured VIN.
- "Open/close" button in the dashboard adds a "via HomeLink" option, or auto-routes through HomeLink when `tesla.atHome` is true.
- MyQ stays in place for state + remote (away-from-home) triggers.

## What I'd need before implementing

1. **Confirm HomeLink is paired** to your garage door at the car (touchscreen → Controls → HomeLink → should list the door).
2. **Virtual key pairing done** (already on the TODO — `docker exec … sh scripts/register-telemetry.sh` after BLE pairing).
3. **`vehicle_cmds` scope on your Fleet API app.** You probably already have it for `set_charge_limit` etc., but worth confirming on the developer portal.

If those are all green, implementation is small — ~30 minutes of code in `lib/tesla.ts` + the new route + a UI toggle.
