#!/usr/bin/env bash
# One-shot kiosk setup for the 12.3" wall-display Pi. Run this ON the Pi
# itself (SSH in, or a terminal if a keyboard's plugged in) after first boot.
# Idempotent — safe to re-run after a change to DASHBOARD_URL below.
#
# Target: Raspberry Pi OS Bookworm (or newer), any Pi model with HDMI out.
# Minimal X11 + openbox kiosk instead of the full desktop's autostart —
# avoids Bookworm's default Wayland/labwc session, whose screen-blanking and
# idle-inhibit config differs from the X11 tools below and isn't worth
# fighting for a box that only ever runs one fullscreen browser tab.
#
# ponytail: no config file, no templating — the URL/resolution are the only
# two things anyone will ever change here, they're right at the top.

set -euo pipefail

DASHBOARD_URL="${1:-https://10.0.6.56:3000/12.3display}"
RES_W=1920
RES_H=720

echo "=== installing minimal X11 + Chromium kiosk stack ==="
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  xserver-xorg xinit x11-xserver-utils openbox chromium unclutter

echo "=== writing .xinitrc (screen blanking off, cursor hidden, Chromium kiosk) ==="
cat > "$HOME/.xinitrc" <<EOF
#!/bin/sh
# Disable all forms of screen blanking/DPMS -- this display should never
# sleep, it's a wall-mounted status panel.
xset s off
xset s noblank
xset -dpms

# Hide the mouse cursor after 0.5s idle -- there's no mouse on this box, but
# a phantom cursor left by the browser itself is common without this.
unclutter -idle 0.5 -root &

exec openbox-session &
sleep 1
exec chromium \\
  --kiosk "$DASHBOARD_URL" \\
  --window-size=$RES_W,$RES_H \\
  --window-position=0,0 \\
  --start-fullscreen \\
  --noerrdialogs \\
  --disable-infobars \\
  --disable-session-crashed-bubble \\
  --disable-pinch \\
  --overscroll-history-navigation=0 \\
  --check-for-update-interval=31536000 \\
  --autoplay-policy=no-user-gesture-required
EOF
chmod +x "$HOME/.xinitrc"

echo "=== enabling console autologin (raspi-config) ==="
sudo raspi-config nonint do_boot_behaviour B2  # B2 = console autologin

echo "=== .bash_profile: startx on the console login, only on tty1 ==="
PROFILE="$HOME/.bash_profile"
touch "$PROFILE"
if ! grep -q 'exec startx' "$PROFILE" 2>/dev/null; then
  cat >> "$PROFILE" <<'EOF'

# Kiosk autostart -- only on the physical console (tty1), so an SSH login
# doesn't also try to launch X.
if [ -z "${DISPLAY:-}" ] && [ "$(tty)" = "/dev/tty1" ]; then
  exec startx -- -nocursor
fi
EOF
fi

echo "=== cloudflared connector (tunnel redundancy) ==="
# Adds this Pi as an additional connector for the existing "Halton Place"
# tunnel -- same pattern as the Firewalla box's connector (see
# homelab-database services.md). If Unraid's own connector drops, this one
# keeps the tunnel's hostnames reachable. Skippable: leave the token blank
# to skip this section entirely (e.g. re-running just to change the URL).
if ! command -v cloudflared &>/dev/null; then
  read -r -s -p "Cloudflare Tunnel token (blank to skip cloudflared setup): " CF_TUNNEL_TOKEN
  echo
  if [ -n "$CF_TUNNEL_TOKEN" ]; then
    # Cloudflare's apt repo (pkg.cloudflare.com) doesn't have a component
    # for every Debian codename (e.g. trixie, as of 2026) -- apt-get update
    # silently skips the unmatched source instead of erroring, then install
    # fails with "Unable to locate package". Grabbing the .deb release
    # directly sidesteps that entirely, works on any codename.
    DEB_ARCH=$(dpkg --print-architecture)  # arm64 or armhf
    curl -fsSL --output /tmp/cloudflared.deb \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${DEB_ARCH}.deb"
    sudo dpkg -i /tmp/cloudflared.deb
    rm -f /tmp/cloudflared.deb
    sudo cloudflared service install "$CF_TUNNEL_TOKEN"
    echo "cloudflared connector installed as a systemd service."
  else
    echo "Skipped -- re-run this script later to add it."
  fi
else
  echo "cloudflared already installed, skipping."
fi

echo
echo "=== done ==="
echo "Reboot to test: sudo reboot"
echo "Dashboard URL:  $DASHBOARD_URL"
echo "Resolution:     ${RES_W}x${RES_H}"
echo "To change the URL later, re-run: $0 <url>"
