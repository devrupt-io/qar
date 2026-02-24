#!/bin/sh
# Startup wrapper script for j4ym0/pia-qbittorrent
# This script reads VPN configuration from shared config files before starting the VPN
#
# The config files are shared between the backend and VPN containers, allowing
# the backend to update VPN settings without complex docker-in-docker approaches.
#
# Config files:
# - /qar/config/vpn.conf: VPN region and port forwarding settings
# - /qar/config/auth.conf: VPN credentials (username on line 1, password on line 2)

CONFIG_FILE="/qar/config/vpn.conf"
AUTH_FILE="/qar/config/auth.conf"

echo "=== Qar VPN Startup Wrapper ==="

# Read VPN region and settings from vpn.conf
if [ -f "$CONFIG_FILE" ]; then
    echo "Reading VPN configuration from $CONFIG_FILE"
    
    # Source the config file to get the values
    # The file uses KEY=value format, same as shell variables
    . "$CONFIG_FILE"
    
    # Export the variables so they're available to child processes
    if [ -n "$PIA_REGION" ]; then
        export PIA_REGION
        echo "  PIA_REGION=$PIA_REGION"
    fi
    
    if [ -n "$PORT_FORWARDING" ]; then
        export PORT_FORWARDING
        echo "  PORT_FORWARDING=$PORT_FORWARDING"
    fi
else
    echo "Warning: Config file $CONFIG_FILE not found, using environment defaults"
fi

# Read VPN credentials from auth.conf and set as environment variables
# The j4ym0/pia-qbittorrent container expects PIA_USERNAME and PIA_PASSWORD
if [ -f "$AUTH_FILE" ]; then
    echo "Reading VPN credentials from $AUTH_FILE"
    
    # Read username (line 1) and password (line 2)
    PIA_USERNAME=$(sed -n '1p' "$AUTH_FILE")
    PIA_PASSWORD=$(sed -n '2p' "$AUTH_FILE")
    
    if [ -n "$PIA_USERNAME" ] && [ -n "$PIA_PASSWORD" ]; then
        export PIA_USERNAME
        export PIA_PASSWORD
        echo "  PIA_USERNAME=***"
        echo "  PIA_PASSWORD=***"
        
        # Also copy to /auth.conf which is the default location the container checks
        cp "$AUTH_FILE" /auth.conf
        chmod 600 /auth.conf
        echo "  Copied credentials to /auth.conf"
    else
        echo "Warning: auth.conf exists but credentials are empty"
    fi
else
    echo "Warning: Auth file $AUTH_FILE not found - VPN credentials not configured"
fi

echo "=== Starting VPN container ==="

# Execute the original entrypoint
# The j4ym0/pia-qbittorrent image uses /entrypoint.sh
exec /entrypoint.sh "$@"
