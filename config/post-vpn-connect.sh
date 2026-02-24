#!/bin/sh
# Post-VPN-connect hook script for Qar
# This script runs after the VPN connects but BEFORE qBittorrent starts
#
# It performs two important tasks:
# 1. Fixes Docker network routing for container-to-container communication
# 2. Configures qBittorrent WebUI to bypass authentication for Docker networks

printf " * Qar post-vpn-connect hook starting...\n"

###########################################
# DEBUG: Print VPN and Port Forwarding Info
###########################################
# Try both REGION and PIA_REGION since the container might use either
VPN_REGION="${REGION:-${PIA_REGION:-not set}}"
printf " * VPN Region: ${VPN_REGION}\n"
printf " * Port Forwarding Enabled: ${PORT_FORWARDING:-not set}\n"

# Check if port forwarding file exists and print the port
if [ -f /config/port.dat ]; then
    FORWARDED_PORT=$(cat /config/port.dat)
    printf " * Forwarded Port: ${FORWARDED_PORT}\n"
else
    printf " * Forwarded Port: (not yet assigned, will be set after VPN connects)\n"
fi

###########################################
# TASK 1: Fix Docker Network Routing
###########################################
# The VPN container uses policy routing (table 128) for its own traffic,
# but the default table 128 doesn't include a direct route for the Docker network subnet.
# Without this, responses to incoming connections go through the gateway instead of directly,
# which causes connection timeouts.

# Get the local subnet from the eth0 interface
LOCAL_SUBNET=$(ip route show dev eth0 | awk '/scope link/ {print $1}' | head -1)

if [ -n "$LOCAL_SUBNET" ]; then
    printf " * Adding Docker subnet route to table 128: $LOCAL_SUBNET\n"
    ip route add $LOCAL_SUBNET dev eth0 table 128 2>/dev/null || true
else
    printf " * Warning: Could not determine local subnet for table 128 route\n"
fi

###########################################
# TASK 2: Configure qBittorrent WebUI Auth Bypass
###########################################
# Configure qBittorrent to bypass authentication for Docker network subnets.
# This allows the Qar backend to communicate with qBittorrent without needing
# to know the WebUI password (which changes on each container restart).
#
# The whitelist covers common Docker network ranges:
# - 172.16.0.0/12: Docker's default bridge networks (172.16.x.x - 172.31.x.x)
# - 10.0.0.0/8: Some Docker overlay networks
# - 192.168.0.0/16: Docker user-defined bridge networks

QBITTORRENT_CONF="/config/qBittorrent/config/qBittorrent.conf"

if [ -f "$QBITTORRENT_CONF" ]; then
    printf " * Configuring qBittorrent WebUI auth bypass for Docker networks\n"
    
    # Check if AuthSubnetWhitelistEnabled already exists (use simple grep pattern)
    if grep -q "AuthSubnetWhitelistEnabled" "$QBITTORRENT_CONF"; then
        # Update existing setting
        sed -i 's/^WebUI\\AuthSubnetWhitelistEnabled=.*/WebUI\\AuthSubnetWhitelistEnabled=true/' "$QBITTORRENT_CONF"
    else
        # Add the setting after [Preferences] section
        sed -i '/^\[Preferences\]/a WebUI\\AuthSubnetWhitelistEnabled=true' "$QBITTORRENT_CONF"
    fi
    
    # Check if AuthSubnetWhitelist (without Enabled) already exists
    if grep -q "^WebUI.AuthSubnetWhitelist=" "$QBITTORRENT_CONF"; then
        # Update existing setting - include all Docker network ranges
        sed -i 's|^WebUI\\AuthSubnetWhitelist=.*|WebUI\\AuthSubnetWhitelist=172.16.0.0/12, 10.0.0.0/8, 192.168.0.0/16|' "$QBITTORRENT_CONF"
    else
        # Add the setting after AuthSubnetWhitelistEnabled
        sed -i '/AuthSubnetWhitelistEnabled/a WebUI\\AuthSubnetWhitelist=172.16.0.0/12, 10.0.0.0/8, 192.168.0.0/16' "$QBITTORRENT_CONF"
    fi
    
    printf " * qBittorrent WebUI auth bypass configured for Docker networks\n"
else
    printf " * Warning: qBittorrent config not found at $QBITTORRENT_CONF\n"
    printf " * Auth bypass will need to be configured manually or on next restart\n"
fi

printf " * Qar post-vpn-connect hook completed\n"

# Print port forwarding info again at the end (may be available now)
if [ -f /config/port.dat ]; then
    FORWARDED_PORT=$(cat /config/port.dat)
    printf " * Final Forwarded Port: ${FORWARDED_PORT}\n"
fi
