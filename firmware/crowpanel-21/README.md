# CrowPanel 2.1" status panel (ESPHome)

Read-only round display for the home lab. It polls the dashboard's `GET /api/panel` every 20 s
(one small JSON, short keys, documented at the top of `lib/panelFeed.ts`). Nothing on the panel writes anywhere.

Pages (turn the knob): Darkbloom Mac 1, Darkbloom Mac 2, Network, Storage, EV tonight, Clock.
Press the knob to show or hide a detail text on the current page. The ring around the edge is the overall
level: green ok, amber attention, red act. Grey ring and "no link" means the panel could not reach the dashboard.

Board: Elecrow CrowPanel Rotary 2.1" (ESP32-S3R8, 8 MB PSRAM, 16 MB flash, ST7701S 480x480, CST816 touch,
encoder A=GPIO42 B=GPIO4, encoder switch on PCF8574 P5). Display, PCF8574 and encoder setup are copied from
Elecrow's ESPHome lesson 05 (Elecrow-RD GitHub repo, `example/esphome`).

## Set up
1. `cp secrets.example.yaml secrets.yaml` and fill in Wi-Fi, `panel_url` (your dashboard host, port and `/api/panel`),
   and made-up values for `api_key` (base64 of 32 random bytes), `ota_password`, `ap_password`.
2. On the dashboard host set the env vars listed under "Panel feed" in the repo `.env.example`
   (`PANEL_BLOOM_LEDGER_URL`, `PANEL_NETMON_URL`, `PANEL_INFLUX_BUCKET`, optional `PANEL_INFLUX_TOKEN`, plus the
   existing `INFLUX_URL`, `INFLUX_ORG`, `INFLUX_TOKEN`).
3. `pip install esphome`, then `esphome config crowpanel-21.yaml` to validate.

## Flash (first time, USB)
Hold BOOT, plug USB into the USB-5V-IN port, release BOOT, then `esphome run crowpanel-21.yaml` and pick the serial port.
Later updates go over Wi-Fi (OTA, password from `secrets.yaml`).

## Notes
- Knob direction: if clockwise goes backwards, swap `lvgl.page.next` and `lvgl.page.previous` in the encoder block.
- Unverified on hardware: the draft was validated with `esphome config`/compile only. Colors, text fit and the
  encoder press (PCF8574 P5, active low) need a look on the real device.
- Not included on purpose: Plex streams, queue depth, weather, Studio temperatures.
