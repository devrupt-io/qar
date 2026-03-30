#!/bin/bash
set -euo pipefail

# Publish Qar .deb packages to a GitHub Pages-hosted APT repository.
#
# Usage: ./packaging/ppa/publish.sh [path-to-deb]
#
# This script:
#   1. Copies the .deb into the ppa/pool/ directory
#   2. Generates APT repository metadata (Packages, Release)
#   3. Signs the Release file with GPG (if key is available)
#
# The resulting ppa/ directory should be deployed to GitHub Pages.
#
# Users add the repo with:
#   curl -fsSL https://devrupt-io.github.io/qar/KEY.gpg | sudo gpg --dearmor -o /usr/share/keyrings/qar.gpg
#   echo "deb [signed-by=/usr/share/keyrings/qar.gpg] https://devrupt-io.github.io/qar stable main" | sudo tee /etc/apt/sources.list.d/qar.list
#   sudo apt update && sudo apt install qar

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PPA_DIR="$SCRIPT_DIR"

DEB_FILE="${1:-$REPO_ROOT/dist/packages/qar_1.0.0_amd64.deb}"

if [ ! -f "$DEB_FILE" ]; then
    echo "Error: .deb file not found: $DEB_FILE"
    echo "Usage: $0 [path-to-deb]"
    exit 1
fi

echo "[ppa] Setting up APT repository structure..."

# Create pool directory and copy .deb
mkdir -p "$PPA_DIR/pool/main"
cp "$DEB_FILE" "$PPA_DIR/pool/main/"

# Create dists directory
DIST_DIR="$PPA_DIR/dists/stable/main/binary-amd64"
mkdir -p "$DIST_DIR"

# Generate Packages file
echo "[ppa] Generating Packages index..."
cd "$PPA_DIR"
dpkg-scanpackages --multiversion pool/ > "$DIST_DIR/Packages" 2>/dev/null || {
    # Fallback: generate Packages manually if dpkg-scanpackages not available
    echo "[ppa] dpkg-scanpackages not found, generating manually..."
    
    DEB_BASENAME=$(basename "$DEB_FILE")
    DEB_SIZE=$(stat -c%s "$PPA_DIR/pool/main/$DEB_BASENAME")
    DEB_MD5=$(md5sum "$PPA_DIR/pool/main/$DEB_BASENAME" | cut -d' ' -f1)
    DEB_SHA256=$(sha256sum "$PPA_DIR/pool/main/$DEB_BASENAME" | cut -d' ' -f1)
    
    # Extract control info
    TMPDIR=$(mktemp -d)
    cd "$TMPDIR"
    ar x "$PPA_DIR/pool/main/$DEB_BASENAME" control.tar.* 2>/dev/null
    tar xf control.tar.* ./control 2>/dev/null || tar xf control.tar.* control 2>/dev/null
    CONTROL=$(cat control)
    cd "$PPA_DIR"
    rm -rf "$TMPDIR"
    
    cat > "$DIST_DIR/Packages" <<EOF
$CONTROL
Filename: pool/main/$DEB_BASENAME
Size: $DEB_SIZE
MD5sum: $DEB_MD5
SHA256: $DEB_SHA256

EOF
}

gzip -kf "$DIST_DIR/Packages"

# Generate Release file
echo "[ppa] Generating Release file..."
RELEASE_DIR="$PPA_DIR/dists/stable"

PACKAGES_SIZE=$(stat -c%s "$DIST_DIR/Packages")
PACKAGES_GZ_SIZE=$(stat -c%s "$DIST_DIR/Packages.gz")
PACKAGES_MD5=$(md5sum "$DIST_DIR/Packages" | cut -d' ' -f1)
PACKAGES_GZ_MD5=$(md5sum "$DIST_DIR/Packages.gz" | cut -d' ' -f1)
PACKAGES_SHA256=$(sha256sum "$DIST_DIR/Packages" | cut -d' ' -f1)
PACKAGES_GZ_SHA256=$(sha256sum "$DIST_DIR/Packages.gz" | cut -d' ' -f1)

cat > "$RELEASE_DIR/Release" <<EOF
Origin: Qar Team
Label: Qar
Suite: stable
Codename: stable
Architectures: amd64
Components: main
Description: Qar - Self-hosted media management system
Date: $(date -Ru)
MD5Sum:
 $PACKAGES_MD5 $PACKAGES_SIZE main/binary-amd64/Packages
 $PACKAGES_GZ_MD5 $PACKAGES_GZ_SIZE main/binary-amd64/Packages.gz
SHA256:
 $PACKAGES_SHA256 $PACKAGES_SIZE main/binary-amd64/Packages
 $PACKAGES_GZ_SHA256 $PACKAGES_GZ_SIZE main/binary-amd64/Packages.gz
EOF

# Sign Release file if GPG key is available
if gpg --list-secret-keys "Qar Team" &>/dev/null; then
    echo "[ppa] Signing Release file..."
    gpg --default-key "Qar Team" -abs -o "$RELEASE_DIR/Release.gpg" "$RELEASE_DIR/Release"
    gpg --default-key "Qar Team" --clearsign -o "$RELEASE_DIR/InRelease" "$RELEASE_DIR/Release"
    
    # Export public key
    gpg --armor --export "Qar Team" > "$PPA_DIR/KEY.gpg"
    echo "[ppa] GPG key exported to $PPA_DIR/KEY.gpg"
else
    echo "[ppa] Warning: No GPG key found for 'Qar Team'"
    echo "[ppa] To create one: gpg --full-generate-key"
    echo "[ppa] The repository will work without signing but apt will show warnings."
fi

echo ""
echo "[ppa] APT repository generated at: $PPA_DIR/"
echo ""
echo "[ppa] To deploy to GitHub Pages:"
echo "  1. Push the ppa/ contents to the gh-pages branch"
echo "  2. Enable GitHub Pages for the repository"
echo ""
echo "[ppa] Users can add the repository with:"
echo '  curl -fsSL https://devrupt-io.github.io/qar/KEY.gpg | sudo gpg --dearmor -o /usr/share/keyrings/qar.gpg'
echo '  echo "deb [signed-by=/usr/share/keyrings/qar.gpg] https://devrupt-io.github.io/qar stable main" | sudo tee /etc/apt/sources.list.d/qar.list'
echo '  sudo apt update && sudo apt install qar'
