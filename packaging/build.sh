#!/bin/bash
# Qar Package Build Script
# Compiles backend and frontend, then uses nfpm to produce .deb and .rpm packages.
#
# Prerequisites:
#   - Node.js >= 18
#   - nfpm (https://nfpm.goreleaser.com/install/)
#
# Usage:
#   ./packaging/build.sh          # Build both .deb and .rpm
#   ./packaging/build.sh deb      # Build only .deb
#   ./packaging/build.sh rpm      # Build only .rpm

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$PROJECT_ROOT/dist"
VERSION=$(cat "$PROJECT_ROOT/VERSION" | tr -d '[:space:]')
FORMAT="${1:-all}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[build]${NC} $1"; }
warn()  { echo -e "${YELLOW}[build]${NC} $1"; }
error() { echo -e "${RED}[build]${NC} $1"; exit 1; }

# ── Preflight checks ────────────────────────────────────────────────────────
command -v node  >/dev/null 2>&1 || error "node is required"
command -v npm   >/dev/null 2>&1 || error "npm is required"
command -v nfpm  >/dev/null 2>&1 || error "nfpm is required (https://nfpm.goreleaser.com/install/)"

info "Building Qar v${VERSION}"

# ── Sync version into package.json files ─────────────────────────────────────
info "Syncing version to package.json files..."
cd "$PROJECT_ROOT"
for pkg in backend/package.json frontend/package.json; do
  if [ -f "$pkg" ]; then
    node -e "
      const fs = require('fs');
      const p = JSON.parse(fs.readFileSync('$pkg','utf8'));
      p.version = '$VERSION';
      fs.writeFileSync('$pkg', JSON.stringify(p, null, 2) + '\n');
    "
  fi
done

# ── Clean previous build ────────────────────────────────────────────────────
info "Cleaning previous build artifacts..."
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR/backend" "$DIST_DIR/frontend" "$DIST_DIR/packages"

# ── Build backend ────────────────────────────────────────────────────────────
info "Building backend..."
cd "$PROJECT_ROOT/backend"

# Install all dependencies (including dev for TypeScript build)
npm install --ignore-scripts
npm run build

# Copy compiled output and production node_modules
cp -r dist/*       "$DIST_DIR/backend/"
cp package.json    "$DIST_DIR/backend/"
cp package-lock.json "$DIST_DIR/backend/"

# Install production-only deps in the dist directory
cd "$DIST_DIR/backend"
npm install --omit=dev

info "Backend built successfully"

# ── Build frontend ───────────────────────────────────────────────────────────
info "Building frontend..."
cd "$PROJECT_ROOT/frontend"

# Build with BACKEND_URL pointing to localhost for native installs
BACKEND_URL=http://localhost:3001 npm install
BACKEND_URL=http://localhost:3001 npm run build

# Copy Next.js standalone output (includes .next/ with server files)
# Use explicit copy since glob * doesn't match hidden directories
cp -r .next/standalone/. "$DIST_DIR/frontend/"
# Add the static assets into the existing .next/ from standalone
cp -r .next/static "$DIST_DIR/frontend/.next/static"
cp -r public       "$DIST_DIR/frontend/public" 2>/dev/null || true

info "Frontend built successfully"

# ── Generate packages ────────────────────────────────────────────────────────
cd "$PROJECT_ROOT"
export QAR_VERSION="$VERSION"

if [ "$FORMAT" = "deb" ] || [ "$FORMAT" = "all" ]; then
  info "Building .deb package..."
  nfpm package --config packaging/nfpm.yaml --packager deb --target "$DIST_DIR/packages/"
  info "Built: $(ls "$DIST_DIR/packages/"*.deb 2>/dev/null)"
fi

if [ "$FORMAT" = "rpm" ] || [ "$FORMAT" = "all" ]; then
  info "Building .rpm package..."
  nfpm package --config packaging/nfpm.yaml --packager rpm --target "$DIST_DIR/packages/"
  info "Built: $(ls "$DIST_DIR/packages/"*.rpm 2>/dev/null)"
fi

echo ""
info "========================================="
info "  Packages built successfully!"
info "  Version: ${VERSION}"
info "  Output:  ${DIST_DIR}/packages/"
info "========================================="
ls -lh "$DIST_DIR/packages/"
