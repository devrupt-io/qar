#!/bin/bash
# Qar Host Setup Script
# This script manages disks, directories, and Docker for the Qar media system.

set -e

QAR_BASE="/qar"
DISKS_DIR="$QAR_BASE/disks"
DOWNLOADS_DIR="$QAR_BASE/downloads"
CONTENT_DIR="$QAR_BASE/content"
CONFIG_DIR="$QAR_BASE/config"
DISKS_CONFIG="$CONFIG_DIR/disks.json"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running as root
check_root() {
    if [ "$EUID" -ne 0 ]; then
        log_error "Please run as root (sudo ./setup.sh)"
        exit 1
    fi
}

# Create base directories
create_directories() {
    log_info "Creating base directories..."
    
    mkdir -p "$QAR_BASE"
    mkdir -p "$DISKS_DIR"
    mkdir -p "$DOWNLOADS_DIR"
    mkdir -p "$CONTENT_DIR/tv"
    mkdir -p "$CONTENT_DIR/movies"
    mkdir -p "$CONTENT_DIR/web"
    mkdir -p "$CONFIG_DIR"
    
    # Set permissions
    chmod -R 755 "$QAR_BASE"
    
    log_info "Base directories created successfully"
}

# Create the default disk (a directory, not a mounted disk)
create_default_disk() {
    local default_disk="$DISKS_DIR/default"
    
    log_info "Creating default disk directory..."
    
    mkdir -p "$default_disk/tv"
    mkdir -p "$default_disk/movies"
    mkdir -p "$default_disk/web"
    
    chmod -R 755 "$default_disk"
    
    # Add default disk to config if not already present
    if [ -f "$DISKS_CONFIG" ]; then
        if ! grep -q '"id": "default"' "$DISKS_CONFIG"; then
            add_disk_to_config "default" "$default_disk" "default" "Default storage directory"
        fi
    else
        # Create initial config with default disk
        cat > "$DISKS_CONFIG" << EOF
{
  "disks": [
    {
      "id": "default",
      "uuid": "default",
      "path": "$default_disk",
      "name": "Default",
      "description": "Default storage directory (not a mounted disk)",
      "enabled": true,
      "isDefault": true
    }
  ]
}
EOF
    fi
    
    log_info "Default disk created at $default_disk"
}

# Create media directories on a disk
setup_disk_directories() {
    local disk_path="$1"
    local disk_name=$(basename "$disk_path")
    
    log_info "Setting up directories for disk: $disk_name"
    
    mkdir -p "$disk_path/tv"
    mkdir -p "$disk_path/movies"
    mkdir -p "$disk_path/web"
    
    chmod -R 755 "$disk_path"
    
    log_info "Disk $disk_name directories created"
}

# Add a disk to the configuration
add_disk_to_config() {
    local id="$1"
    local path="$2"
    local uuid="$3"
    local description="${4:-}"
    
    # This would typically be done via the backend API
    # For now, we just log the information
    log_info "Disk registered: id=$id, uuid=$uuid, path=$path"
}

# Add a new disk by UUID
add_disk() {
    local uuid="$1"
    local mount_point="$2"
    local name="${3:-$uuid}"
    
    if [ -z "$uuid" ] || [ -z "$mount_point" ]; then
        log_error "Usage: setup.sh add-disk <uuid> <mount_point> [name]"
        exit 1
    fi
    
    # Verify the disk exists
    if ! blkid | grep -q "$uuid"; then
        log_error "Disk with UUID $uuid not found"
        exit 1
    fi
    
    # Create mount point in disks directory
    local disk_path="$DISKS_DIR/$name"
    mkdir -p "$disk_path"
    
    # Check if already mounted
    if mountpoint -q "$disk_path" 2>/dev/null; then
        log_warn "Disk is already mounted at $disk_path"
    else
        # Mount the disk
        mount UUID="$uuid" "$disk_path"
        log_info "Mounted disk $uuid at $disk_path"
    fi
    
    # Setup directories
    setup_disk_directories "$disk_path"
    
    # Update config file
    if [ -f "$DISKS_CONFIG" ]; then
        # Use jq if available, otherwise append manually
        if command -v jq &> /dev/null; then
            local tmp_file=$(mktemp)
            jq --arg id "$name" --arg uuid "$uuid" --arg path "$disk_path" \
               '.disks += [{"id": $id, "uuid": $uuid, "path": $path, "name": $id, "enabled": true, "isDefault": false}]' \
               "$DISKS_CONFIG" > "$tmp_file" && mv "$tmp_file" "$DISKS_CONFIG"
        else
            log_warn "jq not installed. Please add disk via the web interface."
        fi
    fi
    
    log_info "Disk $name ($uuid) added successfully"
    log_info "Restart the backend to apply changes: docker compose restart backend"
}

# Remove a disk from configuration
remove_disk() {
    local id="$1"
    
    if [ -z "$id" ]; then
        log_error "Usage: setup.sh remove-disk <disk_id>"
        exit 1
    fi
    
    if [ "$id" = "default" ]; then
        log_error "Cannot remove the default disk"
        exit 1
    fi
    
    local disk_path="$DISKS_DIR/$id"
    
    # Unmount if mounted
    if mountpoint -q "$disk_path" 2>/dev/null; then
        umount "$disk_path"
        log_info "Unmounted $disk_path"
    fi
    
    # Update config file
    if [ -f "$DISKS_CONFIG" ] && command -v jq &> /dev/null; then
        local tmp_file=$(mktemp)
        jq --arg id "$id" '.disks = [.disks[] | select(.id != $id)]' \
           "$DISKS_CONFIG" > "$tmp_file" && mv "$tmp_file" "$DISKS_CONFIG"
    fi
    
    log_info "Disk $id removed from configuration"
    log_info "Note: The mount point directory was not deleted. Remove manually if needed."
}

# List all configured disks
list_disks() {
    log_info "Configured disks:"
    echo "----------------------------------------"
    
    if [ -f "$DISKS_CONFIG" ]; then
        if command -v jq &> /dev/null; then
            jq -r '.disks[] | "  \(.id): \(.path) (UUID: \(.uuid), Enabled: \(.enabled))"' "$DISKS_CONFIG"
        else
            cat "$DISKS_CONFIG"
        fi
    else
        echo "  No disks configured yet."
    fi
    
    echo "----------------------------------------"
}

# Setup configured disks (mount them if needed)
setup_configured_disks() {
    log_info "Setting up configured disks..."
    
    if [ ! -f "$DISKS_CONFIG" ]; then
        log_warn "No disk configuration found. Only default disk will be available."
        return
    fi
    
    if ! command -v jq &> /dev/null; then
        log_warn "jq not installed. Cannot parse disk configuration."
        return
    fi
    
    # Read and setup each disk
    local disk_count=0
    while IFS= read -r disk; do
        local uuid=$(echo "$disk" | jq -r '.uuid')
        local path=$(echo "$disk" | jq -r '.path')
        local enabled=$(echo "$disk" | jq -r '.enabled')
        local is_default=$(echo "$disk" | jq -r '.isDefault')
        
        if [ "$enabled" != "true" ]; then
            continue
        fi
        
        if [ "$is_default" = "true" ]; then
            # Default disk is just a directory, ensure it exists
            mkdir -p "$path/tv" "$path/movies" "$path/web"
            disk_count=$((disk_count + 1))
            continue
        fi
        
        # For real disks, check if mounted
        if [ -d "$path" ]; then
            if ! mountpoint -q "$path" 2>/dev/null; then
                # Try to mount
                if blkid | grep -q "$uuid"; then
                    mount UUID="$uuid" "$path" 2>/dev/null || log_warn "Could not mount disk $uuid"
                else
                    log_warn "Disk with UUID $uuid not found"
                fi
            fi
            setup_disk_directories "$path"
            disk_count=$((disk_count + 1))
        fi
    done < <(jq -c '.disks[]' "$DISKS_CONFIG")
    
    log_info "Set up $disk_count disk(s)"
}

# Check Docker is installed and running
check_docker() {
    log_info "Checking Docker..."
    
    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed. Please install Docker first."
        exit 1
    fi
    
    if ! docker info &> /dev/null; then
        log_error "Docker daemon is not running. Please start Docker."
        exit 1
    fi
    
    if ! docker compose version &> /dev/null; then
        log_error "Docker Compose plugin is not installed. Please install 'docker compose'."
        exit 1
    fi
    
    log_info "Docker is ready"
}

# Get disk usage statistics
get_disk_stats() {
    log_info "Disk Statistics:"
    echo "----------------------------------------"
    
    if [ -f "$DISKS_CONFIG" ] && command -v jq &> /dev/null; then
        while IFS= read -r disk; do
            local id=$(echo "$disk" | jq -r '.id')
            local path=$(echo "$disk" | jq -r '.path')
            local enabled=$(echo "$disk" | jq -r '.enabled')
            
            if [ "$enabled" != "true" ] || [ ! -d "$path" ]; then
                continue
            fi
            
            local usage=$(df -h "$path" 2>/dev/null | tail -1 | awk '{print $3 "/" $2 " (" $5 " used)"}')
            echo "  $id: $usage"
        done < <(jq -c '.disks[]' "$DISKS_CONFIG")
    else
        # Fallback: show all directories in DISKS_DIR
        for disk in "$DISKS_DIR"/*; do
            if [ -d "$disk" ]; then
                local disk_name=$(basename "$disk")
                local usage=$(df -h "$disk" 2>/dev/null | tail -1 | awk '{print $3 "/" $2 " (" $5 " used)"}')
                echo "  $disk_name: $usage"
            fi
        done
    fi
    
    echo "----------------------------------------"
}

# Create systemd service for auto-start
create_systemd_service() {
    log_info "Creating systemd service..."
    
    local service_file="/etc/systemd/system/qar.service"
    local script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
    local compose_dir="$(dirname "$script_path")/.."
    
    cat > "$service_file" << EOF
[Unit]
Description=Qar Media System
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$compose_dir
ExecStartPre=$script_path mount-disks
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down

[Install]
WantedBy=multi-user.target
EOF
    
    systemctl daemon-reload
    systemctl enable qar.service
    
    log_info "Systemd service created and enabled"
}

# Mount all configured disks
mount_disks() {
    log_info "Mounting configured disks..."
    setup_configured_disks
}

# Health check for all services
health_check() {
    log_info "Performing health check..."
    
    # Check if containers are running
    local containers=("qar-postgres" "qar-backend" "qar-frontend" "qar-jellyfin")
    
    for container in "${containers[@]}"; do
        if docker ps --format '{{.Names}}' | grep -q "^${container}$"; then
            echo -e "  ${GREEN}✓${NC} $container is running"
        else
            echo -e "  ${RED}✗${NC} $container is not running"
        fi
    done
    
    # QBittorrent is optional (depends on VPN config)
    if docker ps --format '{{.Names}}' | grep -q "^pia-qbittorrent$"; then
        echo -e "  ${GREEN}✓${NC} pia-qbittorrent is running"
    else
        echo -e "  ${YELLOW}?${NC} pia-qbittorrent is not running (VPN may not be configured)"
    fi
}

# Show help
show_help() {
    echo "Qar Media System Setup Script"
    echo ""
    echo "Usage: sudo ./setup.sh [command]"
    echo ""
    echo "Commands:"
    echo "  (none)         Run initial setup"
    echo "  add-disk       Add a disk by UUID: add-disk <uuid> <mount_point> [name]"
    echo "  remove-disk    Remove a disk: remove-disk <disk_id>"
    echo "  list-disks     List all configured disks"
    echo "  mount-disks    Mount all configured disks"
    echo "  stats          Show disk usage statistics"
    echo "  health         Check health of all services"
    echo "  service        Create and enable systemd service"
    echo "  help           Show this help message"
    echo ""
}

# Main setup function
main() {
    echo "======================================"
    echo "       Qar Media System Setup"
    echo "======================================"
    echo ""
    
    check_root
    check_docker
    create_directories
    create_default_disk
    setup_configured_disks
    get_disk_stats
    
    echo ""
    log_info "Setup complete!"
    echo ""
    echo "Next steps:"
    echo "  1. Add media disks: sudo ./setup.sh add-disk <uuid> <name>"
    echo "  2. Configure environment variables in .env file"
    echo "  3. Run 'docker compose up -d' to start the stack"
    echo ""
}

# Command handling
case "${1:-}" in
    "add-disk")
        check_root
        add_disk "$2" "$DISKS_DIR/${3:-$2}" "${3:-$2}"
        ;;
    "remove-disk")
        check_root
        remove_disk "$2"
        ;;
    "list-disks")
        list_disks
        ;;
    "mount-disks")
        check_root
        mount_disks
        ;;
    "health")
        health_check
        ;;
    "stats")
        get_disk_stats
        ;;
    "service")
        check_root
        create_systemd_service
        ;;
    "help"|"-h"|"--help")
        show_help
        ;;
    *)
        main
        ;;
esac
