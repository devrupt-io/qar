#!/bin/bash
# Qar Install Script
# Detects the OS, adds required repositories, and installs Qar.
#
# Usage:
#   curl -fsSL https://devrupt-io.github.io/qar/install.sh | sudo bash
#
# Supports: Debian 12+, Ubuntu 22.04+, Fedora 40+, RHEL 9+, Rocky 9+, AlmaLinux 9+
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[qar]${NC} $*"; }
warn() { echo -e "${YELLOW}[qar]${NC} $*"; }
err()  { echo -e "${RED}[qar]${NC} $*" >&2; }

# Require root
if [ "$(id -u)" -ne 0 ]; then
  err "This script must be run as root (or with sudo)"
  exit 1
fi

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║          Qar Media System Installer      ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

# Detect OS
detect_os() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_ID="$ID"
    OS_VERSION_ID="${VERSION_ID:-}"
    OS_ID_LIKE="${ID_LIKE:-}"
  else
    err "Cannot detect operating system (/etc/os-release not found)"
    exit 1
  fi

  # Determine the package family
  case "$OS_ID" in
    debian|ubuntu|linuxmint|pop)
      PKG_FAMILY="deb"
      ;;
    fedora)
      PKG_FAMILY="rpm"
      RPM_VARIANT="fedora"
      ;;
    rocky|almalinux|centos|rhel|ol)
      PKG_FAMILY="rpm"
      RPM_VARIANT="el"
      ;;
    *)
      # Try ID_LIKE as fallback
      if echo "$OS_ID_LIKE" | grep -q "debian\|ubuntu"; then
        PKG_FAMILY="deb"
      elif echo "$OS_ID_LIKE" | grep -q "fedora\|rhel\|centos"; then
        PKG_FAMILY="rpm"
        if echo "$OS_ID_LIKE" | grep -q "fedora" && [ "$OS_ID" != "fedora" ]; then
          RPM_VARIANT="el"
        else
          RPM_VARIANT="fedora"
        fi
      else
        err "Unsupported distribution: $OS_ID"
        err "Qar supports Debian/Ubuntu, Fedora, RHEL/Rocky/AlmaLinux"
        exit 1
      fi
      ;;
  esac

  log "Detected: $PRETTY_NAME ($PKG_FAMILY)"
}

# --- Debian/Ubuntu ---
install_deb() {
  log "Updating package lists..."
  apt-get update -qq

  # Install prerequisites
  log "Installing prerequisites..."
  apt-get install -y -qq curl gnupg apt-transport-https > /dev/null

  # Add Jellyfin repository
  if ! [ -f /usr/share/keyrings/jellyfin.gpg ]; then
    log "Adding Jellyfin repository..."
    curl -fsSL https://repo.jellyfin.org/jellyfin_team.gpg.key | gpg --dearmor -o /usr/share/keyrings/jellyfin.gpg
    # Detect codename (fallback to bookworm for unknown)
    local codename
    codename=$(. /etc/os-release && echo "${VERSION_CODENAME:-bookworm}")
    # Jellyfin only supports Debian codenames; map Ubuntu codenames
    case "$codename" in
      jammy|noble|oracular) codename="$codename" ;;   # Ubuntu codenames Jellyfin supports
      bookworm|bullseye|trixie) codename="$codename" ;; # Debian codenames
      *) codename="bookworm" ;;  # Safe fallback
    esac
    local repo_distro
    case "$OS_ID" in
      ubuntu|linuxmint|pop) repo_distro="ubuntu" ;;
      *) repo_distro="debian" ;;
    esac
    echo "deb [signed-by=/usr/share/keyrings/jellyfin.gpg] https://repo.jellyfin.org/$repo_distro $codename main" \
      > /etc/apt/sources.list.d/jellyfin.list
  else
    log "Jellyfin repository already configured"
  fi

  # Add Qar repository
  if ! [ -f /usr/share/keyrings/qar.gpg ]; then
    log "Adding Qar repository..."
    curl -fsSL https://devrupt-io.github.io/qar/KEY.gpg | gpg --dearmor -o /usr/share/keyrings/qar.gpg
    echo "deb [signed-by=/usr/share/keyrings/qar.gpg] https://devrupt-io.github.io/qar stable main" \
      > /etc/apt/sources.list.d/qar.list
  else
    log "Qar repository already configured"
  fi

  # Install
  log "Updating package lists..."
  apt-get update -qq

  log "Installing Qar and dependencies..."
  DEBIAN_FRONTEND=noninteractive apt-get install -y qar
}

# --- Fedora ---
install_rpm_fedora() {
  # Add RPM Fusion (provides Jellyfin)
  if ! rpm -q rpmfusion-free-release &>/dev/null; then
    log "Adding RPM Fusion repository..."
    dnf install -y "https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm"
  else
    log "RPM Fusion already configured"
  fi

  # Add Qar repository
  setup_qar_rpm_repo

  # Install
  log "Installing Qar and dependencies..."
  dnf install -y qar
}

# --- RHEL / Rocky / AlmaLinux (EL9+) ---
install_rpm_el() {
  local el_version
  el_version=$(. /etc/os-release && echo "${VERSION_ID%%.*}")

  # Enable Node.js 20 module stream (EL9 defaults to Node 16 which is too old)
  log "Enabling Node.js 20 module stream..."
  dnf module reset nodejs -y 2>/dev/null || true
  dnf module enable nodejs:20 -y

  # EPEL (needed for qbittorrent-nox, tor)
  if ! rpm -q epel-release &>/dev/null; then
    log "Installing EPEL repository..."
    dnf install -y epel-release
  else
    log "EPEL already configured"
  fi

  # Enable CRB/PowerTools (needed for RPM Fusion deps)
  log "Enabling CRB repository..."
  /usr/bin/crb enable 2>/dev/null || dnf config-manager --set-enabled crb 2>/dev/null || true

  # RPM Fusion
  if ! rpm -q rpmfusion-free-release &>/dev/null; then
    log "Adding RPM Fusion repository..."
    dnf install -y --nogpgcheck "https://mirrors.rpmfusion.org/free/el/rpmfusion-free-release-${el_version}.noarch.rpm"
  else
    log "RPM Fusion already configured"
  fi

  # Add Qar repository
  setup_qar_rpm_repo

  # Install
  log "Installing Qar and dependencies..."
  dnf install -y qar

  # Note about Jellyfin on EL9
  echo ""
  warn "Note: Jellyfin may not be installable from RPM Fusion on EL${el_version}"
  warn "due to ffmpeg version requirements. To install Jellyfin, see:"
  warn "  https://jellyfin.org/docs/general/installation/linux"
}

# Add Qar DNF/YUM repository
setup_qar_rpm_repo() {
  if [ -f /etc/yum.repos.d/qar.repo ]; then
    log "Qar repository already configured"
    return
  fi

  log "Adding Qar repository..."
  rpm --import https://devrupt-io.github.io/qar/rpm/KEY.gpg
  cat > /etc/yum.repos.d/qar.repo << 'EOF'
[qar]
name=Qar - Self-hosted media management
baseurl=https://devrupt-io.github.io/qar/rpm/packages
enabled=1
gpgcheck=1
gpgkey=https://devrupt-io.github.io/qar/rpm/KEY.gpg
EOF
}

# Detect and install
detect_os

case "$PKG_FAMILY" in
  deb)
    install_deb
    ;;
  rpm)
    case "${RPM_VARIANT:-fedora}" in
      fedora) install_rpm_fedora ;;
      el)     install_rpm_el ;;
    esac
    ;;
esac

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         Qar installed successfully!      ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYAN}Frontend:${NC}  http://localhost:3000"
echo -e "  ${CYAN}Config:${NC}    /etc/qar/qar.conf"
echo -e "  ${CYAN}Data:${NC}      /qar/"
echo ""
echo "  To set up VPN-protected downloads:"
echo "    1. Add your PIA credentials to /etc/qar/qar.conf"
echo "    2. sudo systemctl enable --now qar-vpn qar-qbittorrent"
echo ""
