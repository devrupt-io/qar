#!/bin/bash
# Qar pre-remove script
# Stops and disables systemd services before package removal.
set -e

# Stop services if running
systemctl stop qar-frontend.service 2>/dev/null || true
systemctl stop qar-backend.service 2>/dev/null || true
systemctl stop qar-qbittorrent.service 2>/dev/null || true
systemctl stop qar-vpn.service 2>/dev/null || true

# Disable services
systemctl disable qar-frontend.service 2>/dev/null || true
systemctl disable qar-backend.service 2>/dev/null || true
systemctl disable qar-qbittorrent.service 2>/dev/null || true
systemctl disable qar-vpn.service 2>/dev/null || true

systemctl daemon-reload

echo "Qar services stopped and disabled."
