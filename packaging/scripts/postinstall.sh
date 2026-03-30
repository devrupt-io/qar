#!/bin/bash
# Qar post-install script
# Sets permissions and enables systemd services.
set -e

QAR_USER="qar"
QAR_GROUP="qar"

# Set ownership on application files
chown -R "$QAR_USER:$QAR_GROUP" /opt/qar
chown -R "$QAR_USER:$QAR_GROUP" /qar

# Protect the configuration file (readable by qar user only)
chmod 640 /etc/qar/qar.conf
chown root:"$QAR_GROUP" /etc/qar/qar.conf

# Reload systemd and enable services
systemctl daemon-reload
systemctl enable qar-backend.service
systemctl enable qar-frontend.service
systemctl enable qar-qbittorrent.service 2>/dev/null || true
systemctl enable qar-vpn.service 2>/dev/null || true

# On upgrade (not fresh install), restart services that were running
if [ "$1" = "configure" ] && [ -n "$2" ]; then
  # Debian upgrade: $1=configure $2=old-version
  echo "Upgrading from version $2, restarting services..."
  systemctl restart qar-vpn.service 2>/dev/null || true
  sleep 5
  systemctl restart qar-qbittorrent.service 2>/dev/null || true
  systemctl restart qar-backend.service 2>/dev/null || true
  systemctl restart qar-frontend.service 2>/dev/null || true
elif [ "$1" -ge 2 ] 2>/dev/null; then
  # RPM upgrade: $1 >= 2
  echo "Upgrading, restarting services..."
  systemctl restart qar-vpn.service 2>/dev/null || true
  sleep 5
  systemctl restart qar-qbittorrent.service 2>/dev/null || true
  systemctl restart qar-backend.service 2>/dev/null || true
  systemctl restart qar-frontend.service 2>/dev/null || true
else
  # Fresh install: start services automatically
  echo "Starting Qar services..."
  systemctl start qar-vpn.service 2>/dev/null || true
  sleep 5
  systemctl start qar-qbittorrent.service 2>/dev/null || true
  systemctl start qar-backend.service 2>/dev/null || true
  systemctl start qar-frontend.service 2>/dev/null || true
fi

echo ""
echo "============================================"
echo "  Qar has been installed successfully!"
echo "============================================"
echo ""
echo "  Configuration: /etc/qar/qar.conf"
echo "  Data:          /qar/"
echo "  Application:   /opt/qar/"
echo ""
echo "  Next steps:"
echo "    1. Edit /etc/qar/qar.conf with your settings"
echo "    2. Install Jellyfin: https://jellyfin.org/downloads/"
echo "    3. (Optional) Set up a VPN for QBittorrent traffic privacy"
echo "    4. Start Qar:"
echo "       sudo systemctl start qar-backend"
echo ""
echo "  The frontend will be available at http://localhost:3000"
echo "  QBittorrent WebUI will be at http://localhost:8888"
echo "============================================"
echo ""
