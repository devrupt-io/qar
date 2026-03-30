#!/bin/bash
# Qar QEMU Test VM Manager
# Manages Debian and Fedora VMs for testing package installation.
#
# Usage:
#   ./packaging/qemu-test.sh create  [debian|fedora|centos]  Create a fresh VM
#   ./packaging/qemu-test.sh start   [debian|fedora|centos]  Start an existing VM
#   ./packaging/qemu-test.sh stop    [debian|fedora|centos]  Stop the running VM
#   ./packaging/qemu-test.sh ssh     [debian|fedora|centos]  SSH into the running VM
#   ./packaging/qemu-test.sh deploy  [debian|fedora|centos]  Build pkg, copy to VM, install
#   ./packaging/qemu-test.sh status  [debian|fedora|centos]  Show VM status and services
#   ./packaging/qemu-test.sh destroy [debian|fedora|centos]  Stop VM and delete VM files
#   ./packaging/qemu-test.sh wipe    [debian|fedora|centos]  Destroy + create (fresh start)
#   ./packaging/qemu-test.sh test-repo [debian|fedora|centos] Fresh VM, install from published repo
#
# Default distro: debian
# Prerequisites: qemu-system-x86_64, cloud-image-utils (cloud-localds), sshpass
#
# Known limitation: Fedora QEMU testing with user-mode networking (SLIRP) is
# unreliable. DNF5 package transactions on Fedora 42 consistently break the
# SLIRP network stack, causing SSH to become permanently unresponsive. This is
# a QEMU/SLIRP issue, not a package issue — the RPM installs correctly on real
# Fedora systems. Use 'deploy' (with local .rpm + rpm -U) for Fedora testing,
# or test on real hardware. The Debian VM works fully with 'test-repo'.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VM_BASE="/tmp/qar-qemu-test"

# Distro selection (second argument or default)
DISTRO="${2:-debian}"

case "$DISTRO" in
  debian)
    VM_DIR="$VM_BASE/debian"
    BASE_IMAGE_URL="https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-generic-amd64.qcow2"
    BASE_IMAGE_FILE="debian-12-generic-amd64.qcow2"
    SSH_PORT=2222
    SSH_USER=debian
    SSH_PASS=test
    PKG_FORMAT=deb
    ;;
  fedora|centos)
    VM_DIR="$VM_BASE/$DISTRO"
    if [ "$DISTRO" = "centos" ]; then
      BASE_IMAGE_URL="https://dl.rockylinux.org/pub/rocky/9/images/x86_64/Rocky-9-GenericCloud.latest.x86_64.qcow2"
      BASE_IMAGE_FILE="Rocky-9-GenericCloud.latest.x86_64.qcow2"
      SSH_USER=rocky
    else
      BASE_IMAGE_URL="https://download.fedoraproject.org/pub/fedora/linux/releases/42/Cloud/x86_64/images/Fedora-Cloud-Base-Generic-42-1.1.x86_64.qcow2"
      BASE_IMAGE_FILE="Fedora-Cloud-Base-Generic-42-1.1.x86_64.qcow2"
      SSH_USER=fedora
    fi
    SSH_PORT=2223
    SSH_PASS=test
    PKG_FORMAT=rpm
    ;;
  *)
    echo "Unknown distro: $DISTRO (use 'debian', 'fedora', or 'centos')"
    exit 1
    ;;
esac

PID_FILE="$VM_DIR/qemu.pid"
DISK_FILE="$VM_DIR/disk.qcow2"
CLOUD_INIT_ISO="$VM_DIR/cloud-init.iso"
BASE_IMAGE="$VM_BASE/$BASE_IMAGE_FILE"

# VM settings
VM_MEMORY=4096
VM_CPUS=2
VM_DISK_SIZE=20G

# Port forwards: host_port:guest_port
PORT_FORWARDS=(
  "$SSH_PORT:22"
  "3000:3000"
  "3001:3001"
  "8096:8096"
  "8888:8888"
)
# Offset non-SSH ports for RPM distros to avoid conflicts when both VMs run
if [ "$DISTRO" = "fedora" ] || [ "$DISTRO" = "centos" ]; then
  PORT_FORWARDS=(
    "$SSH_PORT:22"
    "4000:3000"
    "4001:3001"
    "9096:8096"
    "9888:8888"
  )
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[qemu:$DISTRO]${NC} $*"; }
warn() { echo -e "${YELLOW}[qemu:$DISTRO]${NC} $*"; }
err()  { echo -e "${RED}[qemu:$DISTRO]${NC} $*" >&2; }

ssh_cmd() {
  sshpass -p "$SSH_PASS" ssh \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR \
    -p "$SSH_PORT" \
    "$SSH_USER@127.0.0.1" "$@"
}

scp_cmd() {
  sshpass -p "$SSH_PASS" scp \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR \
    -P "$SSH_PORT" \
    "$@"
}

is_running() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE")
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

get_pid() {
  cat "$PID_FILE" 2>/dev/null || echo ""
}

wait_for_ssh() {
  log "Waiting for SSH..."
  for i in $(seq 1 60); do
    if ssh_cmd "echo ok" &>/dev/null; then
      log "SSH is ready"
      return 0
    fi
    sleep 3
  done
  err "Timed out waiting for SSH"
  return 1
}

build_port_forwards() {
  local fwds=""
  for pf in "${PORT_FORWARDS[@]}"; do
    local host_port="${pf%%:*}"
    local guest_port="${pf##*:}"
    fwds="${fwds},hostfwd=tcp::${host_port}-:${guest_port}"
  done
  echo "$fwds"
}

cmd_create() {
  if is_running; then
    err "VM is already running (PID: $(get_pid)). Stop it first: $0 stop $DISTRO"
    exit 1
  fi

  mkdir -p "$VM_DIR"

  # Download base image if needed
  if [ ! -f "$BASE_IMAGE" ]; then
    log "Downloading $DISTRO cloud image..."
    curl -L -o "$BASE_IMAGE" "$BASE_IMAGE_URL"
  fi

  # Create VM disk from base image
  log "Creating VM disk ($VM_DISK_SIZE)..."
  cp "$BASE_IMAGE" "$DISK_FILE"
  qemu-img resize "$DISK_FILE" "$VM_DISK_SIZE" 2>/dev/null

  # Create cloud-init config
  log "Creating cloud-init config..."
  cat > "$VM_DIR/user-data" << EOF
#cloud-config
package_update: false
package_upgrade: false
bootcmd:
  - setenforce 0 || true
  - sed -i 's/SELINUX=enforcing/SELINUX=permissive/' /etc/selinux/config || true
users:
  - name: $SSH_USER
    sudo: ALL=(ALL) NOPASSWD:ALL
    lock_passwd: false
    plain_text_passwd: $SSH_PASS
    shell: /bin/bash
ssh_pwauth: true
chpasswd:
  expire: false
runcmd:
  - echo "cloud-init-done" > /tmp/cloud-init-done
EOF
  cat > "$VM_DIR/meta-data" << EOF
instance-id: qar-test-$DISTRO
local-hostname: qar-test-$DISTRO
EOF

  # Create cloud-init ISO
  if command -v cloud-localds &>/dev/null; then
    cloud-localds "$CLOUD_INIT_ISO" "$VM_DIR/user-data" "$VM_DIR/meta-data"
  elif command -v genisoimage &>/dev/null; then
    genisoimage -output "$CLOUD_INIT_ISO" -volid cidata -joliet -rock \
      "$VM_DIR/user-data" "$VM_DIR/meta-data" 2>/dev/null
  elif command -v mkisofs &>/dev/null; then
    mkisofs -output "$CLOUD_INIT_ISO" -volid cidata -joliet -rock \
      "$VM_DIR/user-data" "$VM_DIR/meta-data" 2>/dev/null
  else
    err "Need cloud-localds, genisoimage, or mkisofs to create cloud-init ISO"
    exit 1
  fi

  log "VM created. Starting..."
  cmd_start
}

cmd_start() {
  if is_running; then
    warn "VM is already running (PID: $(get_pid))"
    return 0
  fi

  if [ ! -f "$DISK_FILE" ]; then
    err "No VM disk found. Create one first: $0 create $DISTRO"
    exit 1
  fi

  local kvm_flag=""
  local cpu_flag=""
  if [ -w /dev/kvm ]; then
    kvm_flag="-enable-kvm"
    cpu_flag="-cpu host"
  else
    warn "KVM not available, VM will be slow"
  fi

  local fwds
  fwds=$(build_port_forwards)

  local cdrom_flag=""
  if [ -f "$CLOUD_INIT_ISO" ]; then
    cdrom_flag="-cdrom $CLOUD_INIT_ISO"
  fi

  # shellcheck disable=SC2086
  qemu-system-x86_64 \
    -m "$VM_MEMORY" \
    -smp "$VM_CPUS" \
    $kvm_flag \
    $cpu_flag \
    -drive "file=$DISK_FILE,format=qcow2,cache=unsafe" \
    $cdrom_flag \
    -netdev "user,id=net0${fwds}" \
    -device "virtio-net-pci,netdev=net0" \
    -object "rng-random,id=rng0,filename=/dev/urandom" \
    -device "virtio-rng-pci,rng=rng0" \
    -display none \
    -daemonize \
    -pidfile "$PID_FILE"

  log "VM started (PID: $(get_pid))"
  wait_for_ssh

  log ""
  log "Port mappings:"
  for pf in "${PORT_FORWARDS[@]}"; do
    local host_port="${pf%%:*}"
    local guest_port="${pf##*:}"
    log "  localhost:$host_port → VM:$guest_port"
  done
  log ""
  log "SSH:  ssh -p $SSH_PORT $SSH_USER@localhost  (password: $SSH_PASS)"
  log "  or: $0 ssh $DISTRO"
}

cmd_stop() {
  if ! is_running; then
    warn "VM is not running"
    return 0
  fi

  local pid
  pid=$(get_pid)
  log "Stopping VM (PID: $pid)..."

  # Try graceful shutdown first
  ssh_cmd "sudo shutdown now" 2>/dev/null || true
  sleep 5

  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 2
  fi

  rm -f "$PID_FILE"
  log "VM stopped"
}

cmd_ssh() {
  if ! is_running; then
    err "VM is not running. Start it first: $0 start $DISTRO"
    exit 1
  fi

  exec sshpass -p "$SSH_PASS" ssh \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR \
    -p "$SSH_PORT" \
    "$SSH_USER@127.0.0.1"
}

cmd_deploy() {
  if ! is_running; then
    err "VM is not running. Start it first: $0 start $DISTRO"
    exit 1
  fi

  log "Building .$PKG_FORMAT package..."
  bash "$PROJECT_DIR/packaging/build.sh" "$PKG_FORMAT"

  local pkg_file
  pkg_file=$(ls -t "$PROJECT_DIR/dist/packages/"*."$PKG_FORMAT" 2>/dev/null | head -1)
  if [ -z "$pkg_file" ]; then
    err "No .$PKG_FORMAT file found"
    exit 1
  fi

  log "Deploying $(basename "$pkg_file") to VM..."
  scp_cmd "$pkg_file" "$SSH_USER@127.0.0.1:/tmp/qar.$PKG_FORMAT"

  log "Installing package..."
  if [ "$PKG_FORMAT" = "deb" ]; then
    ssh_cmd "sudo dpkg -i --force-confnew /tmp/qar.deb && sudo apt-get install -f -y"
  else
    ssh_cmd "sudo rpm -Uvh --force /tmp/qar.rpm || sudo dnf install -y /tmp/qar.rpm"
  fi

  log ""
  log "Checking services..."
  sleep 5
  ssh_cmd "sudo systemctl is-active qar-backend qar-frontend qar-vpn qar-qbittorrent jellyfin 2>/dev/null" || true

  log ""
  log "Deploy complete. Access the app:"
  for pf in "${PORT_FORWARDS[@]}"; do
    local host_port="${pf%%:*}"
    local guest_port="${pf##*:}"
    [ "$guest_port" = "22" ] && continue
    log "  localhost:$host_port → :$guest_port"
  done
}

cmd_status() {
  echo ""
  if is_running; then
    log "VM is ${GREEN}running${NC} (PID: $(get_pid))"
    echo ""
    log "Port mappings:"
    for pf in "${PORT_FORWARDS[@]}"; do
      local host_port="${pf%%:*}"
      local guest_port="${pf##*:}"
      if curl -s --max-time 1 "http://localhost:$host_port" &>/dev/null || \
         ssh_cmd "true" &>/dev/null 2>&1; then
        log "  localhost:$host_port → VM:$guest_port  ${GREEN}✓${NC}"
      else
        log "  localhost:$host_port → VM:$guest_port  ${YELLOW}?${NC}"
      fi
    done
    echo ""
    log "Services:"
    ssh_cmd "for s in qar-backend qar-frontend qar-vpn qar-qbittorrent jellyfin; do printf '  %-20s %s\n' \"\$s\" \"\$(sudo systemctl is-active \$s 2>/dev/null)\"; done" 2>/dev/null
    echo ""
    log "SSH: ssh -p $SSH_PORT $SSH_USER@localhost (password: $SSH_PASS)"
  else
    warn "VM is ${RED}not running${NC}"
    if [ -f "$DISK_FILE" ]; then
      log "VM disk exists. Start with: $0 start $DISTRO"
    else
      log "No VM found. Create with: $0 create $DISTRO"
    fi
  fi
  echo ""
}

cmd_destroy() {
  if is_running; then
    cmd_stop
  fi

  if [ -d "$VM_DIR" ]; then
    log "Removing VM files..."
    rm -rf "$VM_DIR"
    log "VM destroyed (base image kept at $VM_BASE/)"
  else
    warn "No VM files found"
  fi
}

cmd_wipe() {
  log "Wiping $DISTRO VM and creating fresh..."
  cmd_destroy
  cmd_create
}

cmd_test_repo() {
  log "============================================"
  log "  Testing $DISTRO install from published repo"
  log "============================================"
  echo ""

  # Destroy existing VM and create fresh
  cmd_destroy
  cmd_create

  log "Waiting for VM to settle..."
  sleep 10

  if [ "$DISTRO" = "debian" ]; then
    log "Installing prerequisites..."
    ssh_cmd "sudo apt-get update -y && sudo apt-get install -y gnupg curl"

    log "Adding Jellyfin repository (required dependency)..."
    ssh_cmd "curl -fsSL https://repo.jellyfin.org/jellyfin_team.gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/jellyfin.gpg"
    ssh_cmd "echo 'deb [signed-by=/usr/share/keyrings/jellyfin.gpg] https://repo.jellyfin.org/debian bookworm main' | sudo tee /etc/apt/sources.list.d/jellyfin.list"

    log "Adding Qar APT repository..."
    ssh_cmd "curl -fsSL https://devrupt-io.github.io/qar/KEY.gpg | sudo gpg --dearmor -o /usr/share/keyrings/qar.gpg"
    ssh_cmd "echo 'deb [signed-by=/usr/share/keyrings/qar.gpg] https://devrupt-io.github.io/qar stable main' | sudo tee /etc/apt/sources.list.d/qar.list"

    log "Updating package lists..."
    ssh_cmd "sudo apt-get update -y"

    log "Installing qar..."
    ssh_cmd "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y qar"

  elif [ "$DISTRO" = "fedora" ] || [ "$DISTRO" = "centos" ]; then
    if [ "$DISTRO" = "fedora" ]; then
      warn "NOTE: Fedora 42 QEMU test-repo is unreliable due to DNF5/SLIRP networking issues."
      warn "Consider using 'centos' distro instead, or test on real hardware."
      echo ""
    fi

    log "Adding EPEL repository..."
    ssh_cmd "sudo dnf install -y epel-release 2>/dev/null || true"

    if [ "$DISTRO" = "centos" ]; then
      log "Enabling Node.js 20 module stream (EL9 default is Node 16)..."
      ssh_cmd "sudo dnf module reset nodejs -y 2>/dev/null; sudo dnf module enable nodejs:20 -y"
    fi

    log "Adding RPM Fusion repository (for Jellyfin)..."
    if [ "$DISTRO" = "centos" ]; then
      log "Enabling CRB repository (required for ffmpeg dependencies)..."
      ssh_cmd "sudo /usr/bin/crb enable || sudo dnf config-manager --set-enabled crb || true"
      ssh_cmd "sudo dnf install -y --nogpgcheck https://mirrors.rpmfusion.org/free/el/rpmfusion-free-release-9.noarch.rpm" || true
    else
      ssh_cmd "sudo rpm -ivh --nosignature https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-\$(rpm -E %fedora).noarch.rpm" || true
    fi

    log "Adding Qar DNF repository..."
    ssh_cmd "sudo rpm --import https://devrupt-io.github.io/qar/rpm/KEY.gpg"
    ssh_cmd "sudo tee /etc/yum.repos.d/qar.repo <<'REPOEOF'
[qar]
name=Qar - Self-hosted media management
baseurl=https://devrupt-io.github.io/qar/rpm/packages
enabled=1
gpgcheck=1
gpgkey=https://devrupt-io.github.io/qar/rpm/KEY.gpg
REPOEOF"

    log "Installing qar..."
    ssh_cmd "sudo dnf install -y qar"
  fi

  log ""
  log "Waiting for services to start..."
  sleep 15

  log "Service status:"
  ssh_cmd "for s in qar-backend qar-frontend qar-vpn qar-qbittorrent jellyfin; do printf '  %-20s %s\n' \"\$s\" \"\$(sudo systemctl is-active \$s 2>/dev/null)\"; done" 2>/dev/null

  log ""
  log "Installed package version:"
  if [ "$DISTRO" = "debian" ]; then
    ssh_cmd "dpkg -l qar 2>/dev/null | tail -1"
  else
    ssh_cmd "rpm -q qar 2>/dev/null"
  fi

  log ""
  log "============================================"
  log "  Test complete! VM is still running."
  log "============================================"
  log ""
  log "Access:"
  for pf in "${PORT_FORWARDS[@]}"; do
    local host_port="${pf%%:*}"
    local guest_port="${pf##*:}"
    [ "$guest_port" = "22" ] && continue
    log "  http://localhost:$host_port"
  done
  log ""
  log "SSH: $0 ssh $DISTRO"
}

# Main
case "${1:-help}" in
  create)    cmd_create ;;
  start)     cmd_start ;;
  stop)      cmd_stop ;;
  ssh)       cmd_ssh ;;
  deploy)    cmd_deploy ;;
  status)    cmd_status ;;
  destroy)   cmd_destroy ;;
  wipe)      cmd_wipe ;;
  test-repo) cmd_test_repo ;;
  *)
    echo -e "${CYAN}Qar QEMU Test VM Manager${NC}"
    echo ""
    echo "Usage: $0 <command> [debian|fedora|centos]"
    echo ""
    echo "Commands:"
    echo "  create    Create a fresh VM and start it"
    echo "  start     Start an existing VM"
    echo "  stop      Gracefully stop the VM"
    echo "  ssh       SSH into the running VM"
    echo "  deploy    Build package, copy to VM, and install"
    echo "  status    Show VM status and services"
    echo "  destroy   Stop VM and delete VM files (keeps base image)"
    echo "  wipe      Destroy + create (fresh start)"
    echo "  test-repo Fresh VM, install from published GitHub repo"
    echo ""
    echo "Distros: debian (default), fedora, centos"
    echo ""
    echo "Examples:"
    echo "  $0 create                # Create Debian VM"
    echo "  $0 create centos         # Create CentOS Stream 9 VM"
    echo "  $0 test-repo debian      # Test APT repo install on fresh Debian"
    echo "  $0 test-repo centos      # Test DNF repo install on fresh CentOS"
    echo "  $0 deploy                # Build .deb and install in Debian VM"
    echo "  $0 deploy centos         # Build .rpm and install in CentOS VM"
    echo "  $0 ssh centos            # SSH into CentOS VM"
    echo ""
    echo "Port mappings:"
    echo "  Debian:         SSH=2222, Frontend=3000, Backend=3001, Jellyfin=8096, QBit=8888"
    echo "  Fedora/CentOS:  SSH=2223, Frontend=4000, Backend=4001, Jellyfin=9096, QBit=9888"
    echo ""
    echo "VM location: $VM_BASE/"
    ;;
esac
