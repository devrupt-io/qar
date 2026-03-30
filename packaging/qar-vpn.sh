#!/bin/bash
# Qar VPN Namespace Manager
# Creates a network namespace with a WireGuard tunnel to PIA VPN,
# isolating QBittorrent traffic so it can ONLY go through the VPN.
#
# Architecture:
#   Host network ←→ veth pair ←→ [qarvpn namespace] ←→ WireGuard ←→ PIA VPN
#   Backend connects to QBittorrent via the veth pair (10.200.200.2:8888)
#   QBittorrent can only reach the internet through WireGuard (kill switch)

set -euo pipefail

NAMESPACE="qarvpn"
VETH_HOST="veth-qar"
VETH_NS="veth-qar-ns"
HOST_IP="10.200.200.1"
NS_IP="10.200.200.2"
SUBNET="10.200.200.0/24"
WG_INTERFACE="wg-qar"

AUTH_CONF="${QAR_AUTH_CONF:-/qar/config/auth.conf}"
VPN_CONF="${QAR_VPN_CONF:-/qar/config/vpn.conf}"
PIA_CA="/qar/config/pia-ca.rsa.4096.crt"
STATE_DIR="/run/qar-vpn"

log() { echo "[qar-vpn] $(date '+%H:%M:%S') $*"; }
die() { log "ERROR: $*"; exit 1; }

# Read PIA credentials from auth.conf
read_credentials() {
    [ -f "$AUTH_CONF" ] || die "Credentials file not found: $AUTH_CONF"
    PIA_USER=$(sed -n '1p' "$AUTH_CONF")
    PIA_PASS=$(sed -n '2p' "$AUTH_CONF")
    [ -n "$PIA_USER" ] || die "PIA username not found in $AUTH_CONF"
    [ -n "$PIA_PASS" ] || die "PIA password not found in $AUTH_CONF"
}

# Read VPN region from vpn.conf
read_vpn_config() {
    PIA_REGION="netherlands"
    PORT_FORWARDING="true"
    if [ -f "$VPN_CONF" ]; then
        while IFS='=' read -r key value; do
            case "$key" in
                PIA_REGION) PIA_REGION="$value" ;;
                PORT_FORWARDING) PORT_FORWARDING="$value" ;;
            esac
        done < "$VPN_CONF"
    fi
    log "Region: $PIA_REGION, Port forwarding: $PORT_FORWARDING"
}

# Authenticate with PIA and get a token
pia_authenticate() {
    log "Authenticating with PIA..."
    local response
    response=$(curl -s -u "${PIA_USER}:${PIA_PASS}" \
        "https://privateinternetaccess.com/gtoken/generateToken" 2>&1) || die "PIA auth request failed"

    PIA_TOKEN=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
    [ -n "$PIA_TOKEN" ] || die "PIA authentication failed. Check credentials in $AUTH_CONF"
    log "PIA authentication successful"
}

# Get the best server for the selected region
pia_get_server() {
    log "Finding best server for region: $PIA_REGION..."
    local serverlist
    serverlist=$(curl -s "https://serverlist.piaservers.net/vpninfo/servers/v6" 2>&1) || die "Failed to fetch server list"

    # Extract the JSON (PIA appends a signature after the JSON)
    local json_end
    json_end=$(echo "$serverlist" | python3 -c "
import sys
data = sys.stdin.read()
idx = data.rfind(']}')
if idx >= 0:
    print(data[:idx+2])
else:
    print(data)
" 2>/dev/null)

    # Find the server for the region
    read -r PIA_SERVER_IP PIA_SERVER_CN PIA_SERVER_WG_PORT <<< $(echo "$json_end" | python3 -c "
import sys, json
data = json.load(sys.stdin)
region_id = '${PIA_REGION}'
for r in data.get('regions', []):
    if r['id'] == region_id or r['name'].lower().replace(' ', '_') == region_id.lower():
        wg = r.get('servers', {}).get('wg', [])
        if wg:
            s = wg[0]
            print(s['ip'], s['cn'], r.get('port_forward', False))
            break
" 2>/dev/null)

    [ -n "$PIA_SERVER_IP" ] || die "No WireGuard server found for region: $PIA_REGION"
    log "Server: $PIA_SERVER_IP ($PIA_SERVER_CN)"
}

# Generate WireGuard keys and register with PIA
pia_setup_wireguard() {
    log "Setting up WireGuard tunnel..."
    mkdir -p "$STATE_DIR"

    # Generate WireGuard key pair
    WG_PRIVKEY=$(wg genkey)
    WG_PUBKEY=$(echo "$WG_PRIVKEY" | wg pubkey)

    # Register with PIA WireGuard endpoint
    local response
    response=$(curl -s -G \
        --connect-to "${PIA_SERVER_CN}::${PIA_SERVER_IP}:" \
        --cacert "$PIA_CA" \
        --data-urlencode "pt=${PIA_TOKEN}" \
        --data-urlencode "pubkey=${WG_PUBKEY}" \
        "https://${PIA_SERVER_CN}:1337/addKey" 2>&1) || die "WireGuard registration failed"

    PIA_WG_STATUS=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
    [ "$PIA_WG_STATUS" = "OK" ] || die "PIA WireGuard setup failed: $response"

    PIA_WG_SERVER_KEY=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('server_key',''))" 2>/dev/null)
    PIA_WG_SERVER_IP=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('server_ip',''))" 2>/dev/null)
    PIA_WG_CLIENT_IP=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('peer_ip',''))" 2>/dev/null)
    PIA_WG_DNS=$(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin).get('dns_servers',[]); print(d[0] if d else '10.0.0.242')" 2>/dev/null)

    log "WireGuard tunnel configured: client=$PIA_WG_CLIENT_IP"

    # Save state for port forwarding
    echo "$PIA_TOKEN" > "$STATE_DIR/token"
    echo "$PIA_SERVER_IP" > "$STATE_DIR/server_ip"
    echo "$PIA_SERVER_CN" > "$STATE_DIR/server_cn"
    chmod 600 "$STATE_DIR/token"
}

# Create the network namespace with WireGuard
create_namespace() {
    log "Creating network namespace: $NAMESPACE"

    # Clean up any previous namespace
    cleanup_namespace 2>/dev/null || true

    # Recreate state directory after cleanup
    mkdir -p "$STATE_DIR"

    # Create namespace
    ip netns add "$NAMESPACE"

    # Bring up loopback in namespace
    ip netns exec "$NAMESPACE" ip link set lo up

    # Create veth pair for host ↔ namespace communication
    ip link add "$VETH_HOST" type veth peer name "$VETH_NS"
    ip link set "$VETH_NS" netns "$NAMESPACE"

    # Configure host side
    ip addr add "${HOST_IP}/24" dev "$VETH_HOST"
    ip link set "$VETH_HOST" up

    # Configure namespace side
    ip netns exec "$NAMESPACE" ip addr add "${NS_IP}/24" dev "$VETH_NS"
    ip netns exec "$NAMESPACE" ip link set "$VETH_NS" up

    # Create WireGuard interface in namespace
    ip link add "$WG_INTERFACE" type wireguard
    ip link set "$WG_INTERFACE" netns "$NAMESPACE"

    # Configure WireGuard
    local wg_conf="$STATE_DIR/wg.conf"
    cat > "$wg_conf" <<EOF
[Interface]
PrivateKey = ${WG_PRIVKEY}

[Peer]
PublicKey = ${PIA_WG_SERVER_KEY}
Endpoint = ${PIA_SERVER_IP}:1337
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
EOF
    chmod 600 "$wg_conf"

    ip netns exec "$NAMESPACE" wg setconf "$WG_INTERFACE" "$wg_conf"
    ip netns exec "$NAMESPACE" ip addr add "${PIA_WG_CLIENT_IP}/32" dev "$WG_INTERFACE"
    ip netns exec "$NAMESPACE" ip link set "$WG_INTERFACE" up

    # Routing in namespace: default through WireGuard (kill switch)
    ip netns exec "$NAMESPACE" ip route add default dev "$WG_INTERFACE"
    # Route to host via veth (for backend access)
    ip netns exec "$NAMESPACE" ip route add "${HOST_IP}/32" dev "$VETH_NS"

    # Set up DNS in namespace
    mkdir -p /etc/netns/"$NAMESPACE"
    echo "nameserver $PIA_WG_DNS" > /etc/netns/"$NAMESPACE"/resolv.conf

    # Enable IP forwarding for veth traffic
    echo 1 > /proc/sys/net/ipv4/ip_forward

    # NAT for namespace → WireGuard (allows replies to come back)
    ip netns exec "$NAMESPACE" iptables -t nat -A POSTROUTING -o "$WG_INTERFACE" -j MASQUERADE

    # Allow forwarding from host to namespace via veth
    iptables -A FORWARD -i "$VETH_HOST" -o "$VETH_HOST" -j ACCEPT 2>/dev/null || true

    # Port forward: localhost:8888 → namespace 10.200.200.2:8888
    # This allows the backend (and users) to access QBittorrent WebUI via localhost
    # Using socat because iptables DNAT doesn't work for localhost → namespace routing
    # Kill any existing process on port 8888 first (e.g. QBittorrent that started on host before namespace was ready)
    local existing_pid
    existing_pid=$(ss -tlnp sport = :8888 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)
    if [ -n "$existing_pid" ]; then
        log "Killing existing process on port 8888 (pid: $existing_pid)"
        kill "$existing_pid" 2>/dev/null || true
        sleep 1
    fi
    socat TCP-LISTEN:8888,bind=0.0.0.0,fork,reuseaddr TCP:${NS_IP}:8888 &
    SOCAT_PID=$!
    echo "$SOCAT_PID" > "$STATE_DIR/socat.pid"

    log "Network namespace created and WireGuard tunnel active"
    log "Port forwarding: localhost:8888 → ${NS_IP}:8888 (socat pid: $SOCAT_PID)"
}

# Clean up the namespace
cleanup_namespace() {
    log "Cleaning up namespace..."
    # Stop socat port forwarder
    if [ -f "$STATE_DIR/socat.pid" ]; then
        kill "$(cat "$STATE_DIR/socat.pid")" 2>/dev/null || true
    fi
    # Remove iptables rules (legacy, in case any remain)
    iptables -t nat -D OUTPUT -p tcp -d 127.0.0.1 --dport 8888 -j DNAT --to-destination ${NS_IP}:8888 2>/dev/null || true
    iptables -t nat -D POSTROUTING -p tcp -d ${NS_IP} --dport 8888 -j MASQUERADE 2>/dev/null || true
    ip netns del "$NAMESPACE" 2>/dev/null || true
    ip link del "$VETH_HOST" 2>/dev/null || true
    rm -rf /etc/netns/"$NAMESPACE" 2>/dev/null || true
    rm -rf "$STATE_DIR" 2>/dev/null || true
}

# Port forwarding refresh loop (PIA requires periodic refresh)
port_forward_loop() {
    if [ "$PORT_FORWARDING" != "true" ]; then
        log "Port forwarding disabled"
        return
    fi

    local token server_ip server_cn
    token=$(cat "$STATE_DIR/token" 2>/dev/null) || return
    server_ip=$(cat "$STATE_DIR/server_ip" 2>/dev/null) || return
    server_cn=$(cat "$STATE_DIR/server_cn" 2>/dev/null) || return

    log "Requesting port forwarding..."

    # Get port forwarding signature
    local pf_response
    pf_response=$(ip netns exec "$NAMESPACE" curl -s -G \
        --connect-to "${server_cn}::${server_ip}:" \
        --cacert "$PIA_CA" \
        --data-urlencode "token=${token}" \
        "https://${server_cn}:19999/getSignature" 2>&1) || { log "Port forward request failed"; return; }

    local pf_status
    pf_status=$(echo "$pf_response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)

    if [ "$pf_status" = "OK" ]; then
        local pf_signature pf_payload pf_port
        pf_signature=$(echo "$pf_response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('signature',''))" 2>/dev/null)
        pf_payload=$(echo "$pf_response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('payload',''))" 2>/dev/null)
        pf_port=$(echo "$pf_payload" | python3 -c "import sys,json,base64; print(json.loads(base64.b64decode(sys.stdin.read())).get('port',''))" 2>/dev/null)

        log "Port forwarding active on port: $pf_port"
        echo "$pf_port" > "$STATE_DIR/forwarded_port"

        # Refresh port binding periodically
        while true; do
            sleep 900  # Refresh every 15 minutes
            ip netns exec "$NAMESPACE" curl -s -G \
                --connect-to "${server_cn}::${server_ip}:" \
                --cacert "$PIA_CA" \
                --data-urlencode "payload=${pf_payload}" \
                --data-urlencode "signature=${pf_signature}" \
                "https://${server_cn}:19999/bindPort" > /dev/null 2>&1 || log "Port forward refresh failed"
        done
    else
        log "Port forwarding not available for this region"
    fi
}

# Main entry point
main() {
    log "Starting Qar VPN..."

    read_credentials
    read_vpn_config
    pia_authenticate
    pia_get_server
    pia_setup_wireguard
    create_namespace

    # Verify connectivity through VPN
    local vpn_ip
    vpn_ip=$(ip netns exec "$NAMESPACE" curl -s --max-time 10 "https://api.ipify.org" 2>/dev/null) || vpn_ip="unknown"
    log "VPN connected! External IP: $vpn_ip"

    # Start port forwarding in background
    port_forward_loop &

    # Keep running (systemd will stop us via SIGTERM)
    log "VPN namespace ready. QBittorrent can now run in namespace: $NAMESPACE"
    
    # Wait for SIGTERM
    trap 'cleanup_namespace; exit 0' TERM INT
    while true; do sleep 3600; done
}

# Handle stop
stop() {
    cleanup_namespace
    exit 0
}

trap stop TERM INT
main "$@"
