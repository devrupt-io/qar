#!/bin/bash
# Qar QEMU Test VM Manager
# Manages Debian 12 VMs for testing .deb package installation.
#
# Usage:
#   ./packaging/qemu-test.sh create    Create a fresh VM and start it
#   ./packaging/qemu-test.sh start     Start an existing VM
#   ./packaging/qemu-test.sh stop      Stop the running VM
#   ./packaging/qemu-test.sh ssh       SSH into the running VM
#   ./packaging/qemu-test.sh deploy    Build .deb, copy to VM, install it
#   ./packaging/qemu-test.sh status    Show VM status and port mappings
#   ./packaging/qemu-test.sh destroy   Stop VM and delete all VM files
#
# Prerequisites: qemu-system-x86_64, cloud-image-utils (cloud-localds), sshpass
# The VM uses KVM acceleration if available.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VM_DIR="/tmp/qar-qemu-test"
PID_FILE="$VM_DIR/qemu.pid"
DISK_FILE="$VM_DIR/debian-test.qcow2"
CLOUD_INIT_ISO="$VM_DIR/cloud-init.iso"
BASE_IMAGE="$VM_DIR/debian-12-generic-amd64.qcow2"
BASE_IMAGE_URL="https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-generic-amd64.qcow2"

# VM settings
VM_MEMORY=2048
VM_CPUS=2
VM_DISK_SIZE=20G
SSH_PORT=2222
SSH_USER=debian
SSH_PASS=test

# Port forwards: host_port:guest_port
PORT_FORWARDS=(
  "$SSH_PORT:22"
  "3000:3000"
  "3001:3001"
  "8096:8096"
  "8888:8888"
)

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[qemu]${NC} $*"; }
warn() { echo -e "${YELLOW}[qemu]${NC} $*"; }
err()  { echo -e "${RED}[qemu]${NC} $*" >&2; }

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
    err "VM is already running (PID: $(get_pid)). Stop it first: $0 stop"
    exit 1
  fi

  mkdir -p "$VM_DIR"

  # Download base image if needed
  if [ ! -f "$BASE_IMAGE" ]; then
    log "Downloading Debian 12 cloud image..."
    curl -L -o "$BASE_IMAGE" "$BASE_IMAGE_URL"
  fi

  # Create VM disk from base image
  log "Creating VM disk ($VM_DISK_SIZE)..."
  cp "$BASE_IMAGE" "$DISK_FILE"
  qemu-img resize "$DISK_FILE" "$VM_DISK_SIZE" 2>/dev/null

  # Create cloud-init ISO
  log "Creating cloud-init config..."
  cat > "$VM_DIR/user-data" << 'EOF'
#cloud-config
users:
  - name: debian
    sudo: ALL=(ALL) NOPASSWD:ALL
    lock_passwd: false
    plain_text_passwd: test
    shell: /bin/bash
ssh_pwauth: true
chpasswd:
  expire: false
runcmd:
  - echo "PermitRootLogin yes" >> /etc/ssh/sshd_config
  - systemctl restart ssh
  - echo "cloud-init-done" > /tmp/cloud-init-done
EOF
  cat > "$VM_DIR/meta-data" << EOF
instance-id: qar-test-vm
local-hostname: qar-test
EOF

  cloud-localds "$CLOUD_INIT_ISO" "$VM_DIR/user-data" "$VM_DIR/meta-data"

  log "VM created. Starting..."
  cmd_start
}

cmd_start() {
  if is_running; then
    warn "VM is already running (PID: $(get_pid))"
    return 0
  fi

  if [ ! -f "$DISK_FILE" ]; then
    err "No VM disk found. Create one first: $0 create"
    exit 1
  fi

  local kvm_flag=""
  if [ -w /dev/kvm ]; then
    kvm_flag="-enable-kvm"
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
    -hda "$DISK_FILE" \
    $cdrom_flag \
    -netdev "user,id=net0${fwds}" \
    -device "virtio-net-pci,netdev=net0,romfile=" \
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
  log "  or: $0 ssh"
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
    err "VM is not running. Start it first: $0 start"
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
    err "VM is not running. Start it first: $0 start"
    exit 1
  fi

  log "Building .deb package..."
  bash "$PROJECT_DIR/packaging/build.sh" deb

  local deb_file
  deb_file=$(ls -t "$PROJECT_DIR/dist/packages/"*.deb 2>/dev/null | head -1)
  if [ -z "$deb_file" ]; then
    err "No .deb file found"
    exit 1
  fi

  log "Deploying $(basename "$deb_file") to VM..."
  scp_cmd "$deb_file" "$SSH_USER@127.0.0.1:/tmp/qar.deb"

  log "Installing package..."
  ssh_cmd "sudo dpkg -i --force-confnew /tmp/qar.deb"

  log ""
  log "Checking services..."
  sleep 5
  ssh_cmd "sudo systemctl is-active qar-backend qar-frontend qar-vpn qar-qbittorrent jellyfin 2>/dev/null" || true

  log ""
  log "Deploy complete. Access the app:"
  log "  Frontend:     http://localhost:3000"
  log "  Backend API:  http://localhost:3001"
  log "  Jellyfin:     http://localhost:8096"
  log "  QBittorrent:  http://localhost:8888"
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
      # Check if port is accessible
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
      log "VM disk exists. Start with: $0 start"
    else
      log "No VM found. Create with: $0 create"
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
    rm -f "$DISK_FILE" "$CLOUD_INIT_ISO" "$PID_FILE"
    rm -f "$VM_DIR/user-data" "$VM_DIR/meta-data"
    # Keep the base image to avoid re-downloading
    log "VM destroyed (base image kept at $BASE_IMAGE)"
  else
    warn "No VM files found"
  fi
}

# Main
case "${1:-help}" in
  create)  cmd_create ;;
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  ssh)     cmd_ssh ;;
  deploy)  cmd_deploy ;;
  status)  cmd_status ;;
  destroy) cmd_destroy ;;
  *)
    echo "Qar QEMU Test VM Manager"
    echo ""
    echo "Usage: $0 <command>"
    echo ""
    echo "Commands:"
    echo "  create   Create a fresh Debian 12 VM and start it"
    echo "  start    Start an existing VM"
    echo "  stop     Gracefully stop the VM"
    echo "  ssh      SSH into the running VM"
    echo "  deploy   Build .deb, copy to VM, and install"
    echo "  status   Show VM status and services"
    echo "  destroy  Stop VM and delete VM files (keeps base image)"
    echo ""
    echo "Typical workflow:"
    echo "  $0 create              # First time: create and boot VM"
    echo "  $0 deploy              # Build and install .deb in VM"
    echo "  $0 ssh                 # Debug inside the VM"
    echo "  $0 stop                # Done for now"
    echo "  $0 start               # Resume later"
    echo "  $0 destroy             # Clean up everything"
    echo ""
    echo "VM location: $VM_DIR"
    echo "SSH: ssh -p $SSH_PORT $SSH_USER@localhost (password: $SSH_PASS)"
    ;;
esac
