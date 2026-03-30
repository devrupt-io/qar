#!/bin/bash
set -euo pipefail

# Publish Qar .rpm packages to a GitHub Pages-hosted DNF/YUM repository.
#
# Usage: ./packaging/rpm-repo/publish.sh [path-to-rpm]
#
# This script:
#   1. Copies the .rpm into the rpm/ directory
#   2. Generates DNF/YUM repository metadata (repodata/)
#   3. Signs the repodata with GPG (if key is available)
#
# The resulting rpm/ directory should be deployed to GitHub Pages.
#
# Users add the repo by creating /etc/yum.repos.d/qar.repo

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RPM_REPO_DIR="$SCRIPT_DIR"

RPM_FILE="${1:-$(ls "$REPO_ROOT"/dist/packages/*.rpm 2>/dev/null | head -1)}"

if [ -z "$RPM_FILE" ] || [ ! -f "$RPM_FILE" ]; then
    echo "Error: .rpm file not found: ${RPM_FILE:-<none>}"
    echo "Usage: $0 [path-to-rpm]"
    exit 1
fi

echo "[rpm] Setting up RPM repository structure..."

# Create packages directory and copy .rpm
mkdir -p "$RPM_REPO_DIR/packages"
cp "$RPM_FILE" "$RPM_REPO_DIR/packages/"

# Generate repository metadata
echo "[rpm] Generating repository metadata..."
if command -v createrepo_c &>/dev/null; then
    createrepo_c --update "$RPM_REPO_DIR/packages/"
elif command -v createrepo &>/dev/null; then
    createrepo --update "$RPM_REPO_DIR/packages/"
else
    echo "[rpm] Warning: createrepo not found, generating minimal repodata manually..."

    RPM_BASENAME=$(basename "$RPM_FILE")
    RPM_SIZE=$(stat -c%s "$RPM_REPO_DIR/packages/$RPM_BASENAME")
    RPM_SHA256=$(sha256sum "$RPM_REPO_DIR/packages/$RPM_BASENAME" | cut -d' ' -f1)

    # Extract basic RPM info using rpm if available, otherwise use filename
    if command -v rpm &>/dev/null; then
        RPM_NAME=$(rpm -qp --queryformat '%{NAME}' "$RPM_REPO_DIR/packages/$RPM_BASENAME" 2>/dev/null || echo "qar")
        RPM_VERSION=$(rpm -qp --queryformat '%{VERSION}' "$RPM_REPO_DIR/packages/$RPM_BASENAME" 2>/dev/null || echo "1.0.0")
        RPM_RELEASE=$(rpm -qp --queryformat '%{RELEASE}' "$RPM_REPO_DIR/packages/$RPM_BASENAME" 2>/dev/null || echo "1")
        RPM_ARCH=$(rpm -qp --queryformat '%{ARCH}' "$RPM_REPO_DIR/packages/$RPM_BASENAME" 2>/dev/null || echo "x86_64")
        RPM_SUMMARY=$(rpm -qp --queryformat '%{SUMMARY}' "$RPM_REPO_DIR/packages/$RPM_BASENAME" 2>/dev/null || echo "Self-hosted media management system")
        RPM_DESCRIPTION=$(rpm -qp --queryformat '%{DESCRIPTION}' "$RPM_REPO_DIR/packages/$RPM_BASENAME" 2>/dev/null || echo "$RPM_SUMMARY")
    else
        # Parse from filename pattern: qar-VERSION-RELEASE.ARCH.rpm
        RPM_NAME="qar"
        RPM_VERSION=$(echo "$RPM_BASENAME" | sed -E 's/^qar-([0-9.]+)-.*/\1/')
        RPM_RELEASE=$(echo "$RPM_BASENAME" | sed -E 's/^qar-[0-9.]+-([0-9]+)\..*/\1/')
        RPM_ARCH="x86_64"
        RPM_SUMMARY="Self-hosted media management system"
        RPM_DESCRIPTION="$RPM_SUMMARY"
    fi

    REPODATA_DIR="$RPM_REPO_DIR/packages/repodata"
    mkdir -p "$REPODATA_DIR"

    TIMESTAMP=$(date +%s)

    # Generate primary.xml
    cat > "$REPODATA_DIR/primary.xml" <<XMLEOF
<?xml version="1.0" encoding="UTF-8"?>
<metadata xmlns="http://linux.duke.edu/metadata/common" xmlns:rpm="http://linux.duke.edu/metadata/rpm" packages="1">
<package type="rpm">
  <name>$RPM_NAME</name>
  <arch>$RPM_ARCH</arch>
  <version epoch="0" ver="$RPM_VERSION" rel="$RPM_RELEASE"/>
  <checksum type="sha256" pkgid="YES">$RPM_SHA256</checksum>
  <summary>$RPM_SUMMARY</summary>
  <description>$RPM_DESCRIPTION</description>
  <url>https://github.com/devrupt-io/qar</url>
  <time file="$TIMESTAMP" build="$TIMESTAMP"/>
  <size package="$RPM_SIZE"/>
  <location href="$RPM_BASENAME"/>
</package>
</metadata>
XMLEOF

    gzip -kf "$REPODATA_DIR/primary.xml"

    PRIMARY_SIZE=$(stat -c%s "$REPODATA_DIR/primary.xml.gz")
    PRIMARY_SHA256=$(sha256sum "$REPODATA_DIR/primary.xml.gz" | cut -d' ' -f1)
    PRIMARY_OPEN_SIZE=$(stat -c%s "$REPODATA_DIR/primary.xml")
    PRIMARY_OPEN_SHA256=$(sha256sum "$REPODATA_DIR/primary.xml" | cut -d' ' -f1)

    # Generate repomd.xml
    cat > "$REPODATA_DIR/repomd.xml" <<XMLEOF
<?xml version="1.0" encoding="UTF-8"?>
<repomd xmlns="http://linux.duke.edu/metadata/repo">
  <revision>$TIMESTAMP</revision>
  <data type="primary">
    <checksum type="sha256">$PRIMARY_SHA256</checksum>
    <open-checksum type="sha256">$PRIMARY_OPEN_SHA256</open-checksum>
    <location href="repodata/primary.xml.gz"/>
    <timestamp>$TIMESTAMP</timestamp>
    <size>$PRIMARY_SIZE</size>
    <open-size>$PRIMARY_OPEN_SIZE</open-size>
  </data>
</repomd>
XMLEOF
fi

# Sign repomd.xml if GPG key is available
REPODATA_DIR="$RPM_REPO_DIR/packages/repodata"
if gpg --list-secret-keys "Qar Team" &>/dev/null && [ -f "$REPODATA_DIR/repomd.xml" ]; then
    echo "[rpm] Signing repomd.xml..."
    gpg --default-key "Qar Team" -abs -o "$REPODATA_DIR/repomd.xml.asc" "$REPODATA_DIR/repomd.xml"

    # Export public key if not already exported
    if [ ! -f "$RPM_REPO_DIR/KEY.gpg" ]; then
        gpg --armor --export "Qar Team" > "$RPM_REPO_DIR/KEY.gpg"
    fi
    echo "[rpm] Signed repomd.xml"
else
    echo "[rpm] Warning: No GPG key found for 'Qar Team' or repodata missing"
    echo "[rpm] The repository will work with gpgcheck=0 but this is not recommended."
fi

echo ""
echo "[rpm] RPM repository generated at: $RPM_REPO_DIR/packages/"
echo ""
echo "[rpm] Users can add the repository with:"
echo ""
echo '  sudo tee /etc/yum.repos.d/qar.repo <<EOF'
echo '  [qar]'
echo '  name=Qar - Self-hosted media management'
echo '  baseurl=https://devrupt-io.github.io/qar/rpm/packages'
echo '  enabled=1'
echo '  gpgcheck=1'
echo '  gpgkey=https://devrupt-io.github.io/qar/rpm/KEY.gpg'
echo '  EOF'
echo '  sudo dnf install qar'
