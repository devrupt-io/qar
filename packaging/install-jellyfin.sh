#!/bin/bash
# Jellyfin Portable Install Script for RPM-based systems (EL9, Fedora)
# Installs Jellyfin from the official portable tarball when the distro
# package is unavailable or broken (e.g., EL9 ffmpeg version mismatch).
#
# This script:
#   1. Downloads the Jellyfin combined server+web tarball
#   2. Extracts to /opt/jellyfin/
#   3. Creates a jellyfin system user
#   4. Sets up a systemd service
#   5. Ensures ffmpeg and fontconfig are installed
#   6. Starts and enables jellyfin
#
# Usage:
#   sudo /opt/qar/install-jellyfin.sh
#   sudo /opt/qar/install-jellyfin.sh 10.11.6   # specific version

set -euo pipefail

JELLYFIN_VERSION="${1:-10.11.6}"
JELLYFIN_URL="https://repo.jellyfin.org/files/server/linux/latest-stable/amd64/jellyfin_${JELLYFIN_VERSION}-amd64.tar.gz"
INSTALL_DIR="/opt/jellyfin"
DATA_DIR="/var/lib/jellyfin"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

log()  { echo -e "${GREEN}[jellyfin]${NC} $*"; }
err()  { echo -e "${RED}[jellyfin]${NC} $*" >&2; }

if [ "$(id -u)" -ne 0 ]; then
  err "This script must be run as root (or with sudo)"
  exit 1
fi

# Check if Jellyfin is already installed via package manager
if command -v jellyfin &>/dev/null || systemctl is-active jellyfin &>/dev/null; then
  log "Jellyfin is already installed and running"
  exit 0
fi

# Check if already installed via this script
if [ -f "$INSTALL_DIR/jellyfin" ] && systemctl is-active jellyfin &>/dev/null; then
  log "Jellyfin portable is already installed and running"
  exit 0
fi

log "Installing Jellyfin ${JELLYFIN_VERSION} portable..."

# Install runtime dependencies
log "Installing runtime dependencies (ffmpeg, fontconfig)..."
if command -v dnf &>/dev/null; then
  dnf install -y ffmpeg fontconfig 2>&1 | tail -3
elif command -v yum &>/dev/null; then
  yum install -y ffmpeg fontconfig 2>&1 | tail -3
fi

# Download and extract
log "Downloading Jellyfin ${JELLYFIN_VERSION}..."
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

curl -fsSL -o "$TMPDIR/jellyfin.tar.gz" "$JELLYFIN_URL"

log "Extracting to ${INSTALL_DIR}..."
mkdir -p "$INSTALL_DIR"
tar xzf "$TMPDIR/jellyfin.tar.gz" -C "$TMPDIR"
# The tarball extracts to a jellyfin/ directory
cp -a "$TMPDIR/jellyfin/"* "$INSTALL_DIR/"

# Create jellyfin system user
if ! getent group jellyfin &>/dev/null; then
  groupadd --system jellyfin
fi
if ! getent passwd jellyfin &>/dev/null; then
  useradd --system --gid jellyfin --home-dir "$DATA_DIR" --no-create-home \
    --shell /usr/sbin/nologin jellyfin
fi

# Create data directories
mkdir -p "$DATA_DIR"/{data,cache,config,log}
chown -R jellyfin:jellyfin "$DATA_DIR"
chown -R jellyfin:jellyfin "$INSTALL_DIR"

# Create systemd service
cat > /etc/systemd/system/jellyfin.service << EOF
[Unit]
Description=Jellyfin Media Server (Portable)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=jellyfin
Group=jellyfin
ExecStart=${INSTALL_DIR}/jellyfin \\
  --datadir ${DATA_DIR}/data \\
  --configdir ${DATA_DIR}/config \\
  --cachedir ${DATA_DIR}/cache \\
  --logdir ${DATA_DIR}/log \\
  --webdir ${INSTALL_DIR}/jellyfin-web
Restart=on-failure
RestartSec=5
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
EOF

# Start Jellyfin
systemctl daemon-reload
systemctl enable --now jellyfin

# Wait for Jellyfin to become responsive
log "Waiting for Jellyfin to start..."
for i in $(seq 1 30); do
  if curl -sf -o /dev/null http://127.0.0.1:8096/ 2>/dev/null; then
    log "Jellyfin is running at http://localhost:8096/"
    exit 0
  fi
  sleep 1
done

# Check if it's at least active even if HTTP isn't responding yet
if systemctl is-active jellyfin &>/dev/null; then
  log "Jellyfin service is active (may still be initializing)"
  log "Access it at http://localhost:8096/"
else
  err "Jellyfin failed to start. Check: journalctl -u jellyfin"
  exit 1
fi
