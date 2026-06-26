# SolarEdge — enable Modbus/TCP (print sheet)

**Inverter**: SE11400H-US000BEU5 (HD-Wave 11.4 kW, SetApp / no LCD)
**Target LAN IP**: `10.0.5.50` (already reachable from Unraid — `ev-dashboard` container can ping it)

---

## Before you head to the inverter

- [ ] Have your phone handy — you'll be on the inverter's WiFi for 5 minutes, so download SolarEdge SetApp from the App Store / Play Store *before* you swap WiFi networks.
- [ ] Know the installer password. Default is `12312312`. If yours was changed, call SolarEdge installer support before you toggle the switch.
- [ ] Tell me / Claude before you start so the dashboard side is running. The Modbus port closes again if nothing connects within 2 minutes of saving the setting.

---

## At the inverter

1. **Flip into SetApp mode**
   Locate the red P / 1 / 0 toggle on the bottom of the inverter.
   Move it to **P** for **less than 5 seconds**, then back to **1**.
   WiFi Direct goes live for ~30 minutes.

2. **Join the inverter's WiFi from your phone**
   SSID: `SE-WiFiDirect_<serial-number>`
   Password: 8-digit code printed on the inverter's side label.

3. **Open SetApp** (or browse to `http://172.16.0.1` from a laptop)
   Log in as **Installer**, password `12312312` unless your installer changed it.

4. **Enable Modbus/TCP**
   Menu path: **Site Communication → Modbus TCP**
   - Toggle **Enable** to ON
   - Port: **1502** (default — leave as-is)
   - Device ID: **1** (default — leave as-is)
   - Hit **Save** / back-arrow to commit

5. **Power-cycle out of SetApp mode**
   Flip the red toggle back to **1**.
   The Modbus port stays open on `10.0.5.50:1502` going forward.

6. **Tell me the inverter is enabled — *fast*.**
   The 2-minute first-connect window starts at step 4 save.
   If we miss it, redo step 4.

---

## How we'll know it's working

After step 5, the `ev-dashboard` container's logs should show a successful Modbus read. If they show timeouts or "connection refused", we redo the WiFi Direct step and re-enable Modbus.

`docker logs -f ev-dashboard-ev-dashboard-1 | grep -i solaredge`

---

## If something goes wrong

- **Forgot the installer password**: SolarEdge installer support, US tollfree. They verify site ownership and reset.
- **WiFi Direct doesn't appear**: held the toggle too long (>5s puts the inverter into shutdown). Wait 30 seconds, retry.
- **Modbus enabled but nothing connects within 2 min**: the port closes. Redo SetApp menu, re-enable, re-save.
- **Cloud monitoring stops working** (shouldn't happen, but if it does): toggle Modbus back off in SetApp. Cloud and Modbus are supposed to coexist; if they don't in your case it's a firmware quirk and we go cloud-only via API key.
