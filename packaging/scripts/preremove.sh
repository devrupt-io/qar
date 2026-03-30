#!/bin/bash
# Qar pre-remove script
# Stops and disables systemd services before package removal.
# On upgrade, skip — the postinstall handles restarts.
set -e

# Detect upgrade vs full removal
# RPM: $1 = number of remaining versions (0 = full remove, >= 1 = upgrade)
# Debian: $1 = "remove" or "upgrade"
if [ "$1" = "upgrade" ] || [ "$1" -ge 1 ] 2>/dev/null; then
  echo "Qar upgrade in progress, skipping service stop."
  exit 0
fi

# Full removal: stop and disable services
systemctl stop qar-frontend.service 2>/dev/null || true
systemctl stop qar-backend.service 2>/dev/null || true
systemctl stop qar-qbittorrent.service 2>/dev/null || true
systemctl stop qar-vpn.service 2>/dev/null || true

systemctl disable qar-frontend.service 2>/dev/null || true
systemctl disable qar-backend.service 2>/dev/null || true
systemctl disable qar-qbittorrent.service 2>/dev/null || true
systemctl disable qar-vpn.service 2>/dev/null || true

systemctl daemon-reload

echo "Qar services stopped and disabled."
