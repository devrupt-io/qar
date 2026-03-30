#!/bin/bash
# Qar RPM post-transaction script
# Runs AFTER all install/remove phases complete during an upgrade.
# This ensures services are running after the old package's preremove has executed.
set -e

# Restart services that should be running after upgrade
if systemctl is-enabled qar-backend.service &>/dev/null; then
  systemctl restart qar-backend.service 2>/dev/null || true
fi
if systemctl is-enabled qar-frontend.service &>/dev/null; then
  systemctl restart qar-frontend.service 2>/dev/null || true
fi
if systemctl is-enabled qar-vpn.service &>/dev/null; then
  systemctl restart --no-block qar-vpn.service 2>/dev/null || true
fi
if systemctl is-enabled qar-qbittorrent.service &>/dev/null; then
  systemctl restart --no-block qar-qbittorrent.service 2>/dev/null || true
fi
