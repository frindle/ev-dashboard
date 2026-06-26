# SolarEdge integration — research + recommendation

Date: 2026-06-26

You asked me to investigate two paths: SolarEdge's cloud monitoring API
and the Home Assistant `solaredge-modbus-multi` local integration. Here's
the landscape and my recommendation.

---

## Path A — Cloud Monitoring API (monitoringapi.solaredge.com)

**Base URL**: `https://monitoringapi.solaredge.com/`

**Auth**: 32-char `api_key` passed as a query parameter on every request
(e.g. `?api_key=ABCD…`). Per-site key (not per-account), tied to one Site
ID.

**Endpoints we'd actually use**:

| Endpoint | What it returns |
|---|---|
| `GET /site/{siteId}/overview` | Lifetime / yearly / monthly / daily energy + current power |
| `GET /site/{siteId}/currentPowerFlow` | Live PV → grid / loads / battery flow (W) |
| `GET /site/{siteId}/power?startTime&endTime` | 15-min power buckets |
| `GET /site/{siteId}/energy?timeUnit=DAY` | Daily kWh series |
| `GET /equipment/{siteId}/{serial}/data` | Per-inverter telemetry |

**Where to get the API key** — and the snag you hit:

The path is `monitoring.solaredge.com → Admin → Site Access → API Access`
(the "Provider" tab), where the **site admin** clicks "New key" and is
shown a 32-char string. Two things commonly hide it:

1. **You need site admin role**, not just monitoring access. If your
   installer created the site under their account and only granted you
   "Owner" / "Viewer", the API Access tab is hidden. Workaround: ask the
   installer to add you as Admin, or request the key from them and they
   email it to you.
2. **The Admin menu only appears in the "classic" Monitoring UI**. The
   newer SolarEdge ONE dashboard at monitoringapi.solaredge.com hides it.
   Click "Switch to Classic" in the top-right, then the Admin tab shows
   up.

There is no v1 vs v2 split — `monitoringapi.solaredge.com` is the only
public REST surface and SolarEdge has not announced a v2. They sometimes
call it "Monitoring API v1" internally; the URLs are unversioned.

**Rate limits**: 300 requests/day per account, plus 300/day per site.
Easy to fit a 5-minute poll into (288 polls/day). Not enough for real-
time (sub-minute) updates.

**Pros / cons**:
- ✅ No on-prem network access required — works from your Unraid box to
  the internet.
- ✅ Stable, documented, paginated.
- ❌ Rate limits cap us at ~5-min granularity.
- ❌ Couples us to SolarEdge's cloud — if their portal is down, the
  dashboard goes dark.
- ❌ The API key handoff requires Site Admin access.

---

## Path B — Modbus/TCP local (HA `solaredge-modbus-multi`)

The `WillCodeForCats/solaredge-modbus-multi` Home Assistant integration
polls the inverter directly over Modbus/TCP on the LAN. We don't have
to run HA — we can use the same SunSpec register layout from a Node
client (e.g., `jsmodbus`).

**Inverter-side enable** (this is the one-time setup you'd do):

- **SetApp inverters (no LCD)**: flip the red toggle to `P` (< 5 sec) to
  enable WiFi Direct, connect to the inverter's AP using the password
  printed on the unit, browse to `http://172.16.0.1`, go to
  **Site Communication** → enable Modbus/TCP.
- **LCD inverters**: enter installer mode (hold OK 5 sec, default
  password `12312312`), then `Communications → LAN → Modbus/TCP`.
- **Port**: default is **1502, not 502** (a common gotcha — port 502 is
  the unencrypted Modbus standard, SolarEdge uses 1502 for their TCP).
- **Device ID**: default 1. Multiple inverters in a leader/follower
  chain must each have a unique Device ID.
- **Timing trap**: the first connection must happen **within 2 minutes**
  of enabling Modbus/TCP, otherwise the port closes and you have to
  re-enable. After the first successful connect, the port stays open.

**Crucially: cloud monitoring keeps working**. The Modbus port and the
cloud uplink are independent. You don't lose monitoring.solaredge.com
access by turning Modbus on.

**Single-master limitation**: only **one Modbus/TCP client at a time**.
If you ever run HA + our dashboard, they'll fight. Our integration would
need to be the only consumer.

**Data we'd get from SunSpec registers**:

- Current AC power (W) — real-time, sub-second if we wanted it
- Lifetime energy (Wh)
- Daily energy (Wh)
- Per-string DC voltage / current
- Battery SoC (if you have one — you don't right now)
- Meter readings if a SolarEdge meter is wired

**Pros / cons**:
- ✅ No API key, no rate limit, no cloud dependency.
- ✅ Sub-second polling possible (we'd cap at 5–10s).
- ✅ Works even when monitoring.solaredge.com is down.
- ❌ Requires the dashboard to reach the inverter on the LAN — Docker
  on Unraid macvlan needs to route to whatever VLAN the inverter sits
  on. Probably already works since the Rivian connector is also on
  your LAN, but worth confirming.
- ❌ The 2-minute first-connect window means we should have the code
  ready before flipping Modbus on at the inverter.

---

## Recommendation

**Go local Modbus/TCP (Path B)**. Reasons:

1. You hit the API-key visibility problem already — Path A requires
   chasing down site admin permissions, and even when that's resolved
   it caps us at 5-min polling.
2. The dashboard's whole point is live state. Sub-minute solar updates
   matter more for the "should I plug the EV in now?" decision than for
   any historical reporting we need from the cloud API.
3. We can backfill historical data later from cloud (overview endpoint)
   without changing the live path. Best of both worlds, eventually.

**Plan to implement**:

1. **Code first** (so we're inside the 2-min window): new
   `ev-dashboard/lib/solaredge.ts` using `jsmodbus` to read SunSpec
   registers 40069+ (model 103 inverter block). Returns `{ acPowerW,
   dailyKwh, lifetimeKwh, status }`. Cache in-memory at 10s.
2. **Config**: add `solaredge.host` + `solaredge.unitId` to
   `ev-dashboard.config.json` (or admin UI).
3. **Dashboard surface**: small solar tile near the wall connector
   card showing current PV power + today's kWh. When PV > house+EV
   draw, badge "exporting".
4. **Enable Modbus on the inverter** during a dedicated window — you
   trigger WiFi Direct, I tail the docker logs of the dashboard, we
   confirm first connect within 2 min, then move on.

If at any point the LAN route doesn't work (Docker on macvlan can't
reach the inverter), we fall back to cloud + chase down the API key.

---

## What I need from you before I write the integration

- **Inverter model + firmware** — if you know off the top of your head,
  great; otherwise I'll wait until you're at the inverter to flip
  Modbus on and you can read it off the label.
- **Local IP of the inverter** — get this from your router after Modbus
  is enabled (the inverter usually gets DHCP).
- **Unraid → inverter routing** — confirm whether your macvlan setup
  allows the `ev-dashboard` container to reach the inverter's IP. Easiest
  check: `docker exec ev-dashboard-ev-dashboard-1 ping -c1 <inverter-ip>`.
