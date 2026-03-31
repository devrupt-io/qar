#!/bin/bash
# Qar post-install script
# Sets permissions and enables systemd services.
set -e

QAR_USER="qar"
QAR_GROUP="qar"

# Check Node.js version (require >= 18 for fetch API / Request class)
NODE_VERSION=$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1)
if [ -n "$NODE_VERSION" ] && [ "$NODE_VERSION" -lt 18 ] 2>/dev/null; then
  echo ""
  echo "WARNING: Node.js $(node --version) is installed, but Qar requires Node.js >= 18."
  echo "On RHEL/Rocky/Alma, enable a newer module stream:"
  echo "  sudo dnf module enable nodejs:20 -y && sudo dnf install -y nodejs"
  echo ""
fi

# Set ownership on application files
chown -R "$QAR_USER:$QAR_GROUP" /opt/qar
chown -R "$QAR_USER:$QAR_GROUP" /qar

# Protect the configuration file (readable by qar user only)
chmod 640 /etc/qar/qar.conf
chown root:"$QAR_GROUP" /etc/qar/qar.conf

# Reload systemd and enable core services
systemctl daemon-reload
systemctl enable qar-backend.service
systemctl enable qar-frontend.service
# VPN and qbittorrent are NOT enabled by default — user must configure
# PIA VPN credentials in /etc/qar/qar.conf first, then:
#   sudo systemctl enable --now qar-vpn qar-qbittorrent

# On upgrade (not fresh install), restart services that were running
if [ "$1" = "configure" ] && [ -n "$2" ]; then
  # Debian upgrade: $1=configure $2=old-version
  echo "Upgrading from version $2, restarting services..."
  systemctl restart qar-backend.service 2>/dev/null || true
  systemctl restart qar-frontend.service 2>/dev/null || true
  systemctl restart --no-block qar-vpn.service 2>/dev/null || true
  systemctl restart --no-block qar-qbittorrent.service 2>/dev/null || true
elif [ "$1" -ge 2 ] 2>/dev/null; then
  # RPM upgrade: $1 >= 2
  # Skip restart here — rpm-posttrans.sh handles it after old package cleanup
  echo "Upgrading Qar..."
else
  # Fresh install: start core services only
  # VPN/qbittorrent are NOT started — they require PIA VPN credentials
  # to be configured in /etc/qar/qar.conf first, otherwise they block
  # systemd's job queue and prevent other services from starting.
  echo "Starting Qar services..."
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
echo "    2. (Optional) Configure VPN for private downloads:"
echo "       - Add PIA credentials to /etc/qar/qar.conf"
echo "       - sudo systemctl enable --now qar-vpn qar-qbittorrent"
echo ""
echo "  The frontend will be available at http://localhost:3000"
echo "  QBittorrent WebUI will be at http://localhost:8888"
echo "============================================"
echo ""
