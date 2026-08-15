# 12.3" wall-display Pi — kiosk setup

Target: `https://ev-dashboard.penndalton.com/12.3display`, real resolution 1920x720.

## 1. Flash the SD card (do this on any computer, no Pi needed yet)

1. Install [Raspberry Pi Imager](https://www.raspberrypi.com/software/) if you don't have it.
2. Choose OS: **Raspberry Pi OS (64-bit)** — the full version with desktop, not Lite (Lite has no X server for Chromium to run in).
3. Choose storage: the SD card.
4. Click the gear icon (**Edit Settings**) before writing — this is what makes the whole rest of this headless:
   - Set hostname, e.g. `ev-dashboard-pi`
   - Enable SSH, use password auth (or paste a public key)
   - Set username/password
   - Configure WiFi: SSID + password + your country code (skip if using Ethernet)
   - Set locale/timezone
5. Write. Eject when done.

## 2. First boot

Insert the card into the Pi, connect it to the panel via HDMI, power it on. Give it 1-2 minutes on first boot.

Find its IP — check the router/Firewalla device list for the hostname you set (`ev-dashboard-pi`), or try `ping ev-dashboard-pi.local`.

## 3. Run the kiosk setup script

SSH in from anywhere on the network (or remotely if the Pi has a public path — it normally shouldn't need one, LAN-only is fine for a wall display):

```
ssh <username>@ev-dashboard-pi.local
```

Then either `scp` this repo's `scripts/kiosk-setup.sh` over, or just paste its contents into a file on the Pi directly:

```
curl -o kiosk-setup.sh https://raw.githubusercontent.com/frindle/ev-dashboard/main/scripts/kiosk-setup.sh
chmod +x kiosk-setup.sh
./kiosk-setup.sh
sudo reboot
```

After reboot it should come up straight into the fullscreen dashboard, no login screen, no cursor, screen never sleeps.

## Tunnel redundancy (optional)

The setup script also offers to install `cloudflared` as an additional
connector for the existing "Halton Place" Cloudflare Tunnel — same pattern
as the Firewalla box's connector. If Unraid's own connector ever drops,
this Pi keeps the tunnel's hostnames reachable. It'll prompt for a tunnel
token during setup; leave it blank to skip (safe to add later by re-running
the script). Get a fresh token from the Cloudflare dashboard → Zero Trust →
Networks → Tunnels → Halton Place → Configure, or via the API — don't reuse
a token from chat/notes, tokens are meant to be regenerated per install
if there's any doubt about exposure.

## Changing the URL later

```
./kiosk-setup.sh https://some-other-url
sudo reboot
```

## Troubleshooting

- **Black screen / no HDMI signal**: check the HDMI cable is in the Pi's HDMI0 port (some models have two), and that the panel's input is set correctly.
- **Chromium shows a "restore session" bubble on reboot**: the script already passes `--disable-session-crashed-bubble`; if it still appears, the profile dir may have a stale `Default/Preferences` marking an unclean exit — safe to delete `~/.config/chromium` and let it recreate.
- **Wrong aspect ratio / looks squished**: confirm the panel's actual EDID-reported resolution matches 1920x720 — `xrandr` on the Pi (over SSH with `DISPLAY=:0 xrandr`) will show what X actually negotiated with the panel.
