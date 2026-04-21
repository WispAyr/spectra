#!/bin/bash
# SPECTRA Pi Setup Script
# Run as: sudo bash setup-pi.sh
set -e

echo "╔══════════════════════════════════════╗"
echo "║  SPECTRA — Pi Setup Script           ║"
echo "║  SDRplay nRSP-ST Intelligence Hub    ║"
echo "╚══════════════════════════════════════╝"
echo ""

SPECTRA_DIR="/opt/spectra"
SERVICE_USER="pi"

# ── 1. System packages ────────────────────────────────────────────
echo "[1/8] Installing system dependencies..."
apt-get update -qq
apt-get install -y \
  curl git build-essential libusb-1.0-0-dev \
  cmake libfftw3-dev pkg-config \
  sox libsox-fmt-all \
  python3 python3-pip \
  sqlite3 \
  2>/dev/null

# ── 2. Node.js 20 ────────────────────────────────────────────────
echo "[2/8] Installing Node.js 20..."
if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d 'v') -lt 18 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "  Node: $(node -v)"

# ── 3. SDRplay API ───────────────────────────────────────────────
echo "[3/8] SDRplay API setup..."
echo "  NOTE: Download SDRplay API from https://www.sdrplay.com/downloads/"
echo "  For ARM64 (Pi 4/5): SDRplay_RSP_API-ARM64-3.x.x.run"
echo "  Run: chmod +x SDRplay_RSP_API-ARM64-*.run && sudo ./SDRplay_RSP_API-ARM64-*.run"
echo "  This must be done manually. Skipping for now."

# ── 4. SoapySDR + SoapySDRPlay ───────────────────────────────────
echo "[4/8] Installing SoapySDR..."
apt-get install -y soapysdr-tools python3-soapysdr 2>/dev/null || {
  echo "  SoapySDR not in apt — building from source (this takes a while)..."
  cd /tmp
  git clone --depth 1 https://github.com/pothosware/SoapySDR.git 2>/dev/null
  cd SoapySDR && mkdir -p build && cd build
  cmake .. -DCMAKE_BUILD_TYPE=Release
  make -j$(nproc) && make install && ldconfig
  cd /tmp
}

# ── 5. dump1090-fa (ADS-B decoder) ───────────────────────────────
echo "[5/8] Installing dump1090-fa..."
if ! command -v dump1090-fa &>/dev/null; then
  apt-get install -y dump1090-fa 2>/dev/null || {
    echo "  dump1090-fa not available. Installing readsb as alternative..."
    apt-get install -y readsb 2>/dev/null || echo "  Skipping ADS-B decoder (install manually)"
  }
fi

# ── 6. direwolf (APRS decoder) ───────────────────────────────────
echo "[6/8] Installing direwolf (APRS)..."
apt-get install -y direwolf 2>/dev/null || {
  echo "  direwolf not in apt — building from source..."
  cd /tmp
  git clone --depth 1 https://github.com/wb2osz/direwolf.git 2>/dev/null
  cd direwolf && mkdir -p build && cd build
  cmake .. && make -j$(nproc) && make install
  cd /tmp
}

# ── 7. rtl_433 (IoT decoder) ─────────────────────────────────────
echo "[7/8] Installing rtl_433..."
apt-get install -y rtl-433 2>/dev/null || {
  echo "  rtl_433 not in apt — building..."
  cd /tmp
  git clone --depth 1 https://github.com/merbanan/rtl_433.git 2>/dev/null
  cd rtl_433 && mkdir -p build && cd build
  cmake -DENABLE_SOAPYSDR=ON ..
  make -j$(nproc) && make install
  cd /tmp
}

# ── 8. SPECTRA app ───────────────────────────────────────────────
echo "[8/8] Installing SPECTRA..."
mkdir -p $SPECTRA_DIR
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cp -r "$SCRIPT_DIR"/* $SPECTRA_DIR/
cd $SPECTRA_DIR
npm install --production 2>/dev/null

# Create recordings dir
mkdir -p $SPECTRA_DIR/recordings $SPECTRA_DIR/db
chown -R $SERVICE_USER:$SERVICE_USER $SPECTRA_DIR

# Install systemd service
cp "$SCRIPT_DIR/scripts/systemd/spectra.service" /etc/systemd/system/spectra.service
systemctl daemon-reload
systemctl enable spectra
systemctl start spectra

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  SPECTRA installed successfully!     ║"
echo "║                                      ║"
echo "║  Dashboard: http://$(hostname -I | awk '{print $1}'):3000  ║"
echo "║                                      ║"
echo "║  Next steps:                         ║"
echo "║  1. Install SDRplay API (see step 3) ║"
echo "║  2. Edit /opt/spectra/config.json    ║"
echo "║     - Set nrsp.host to nRSP-ST IP    ║"
echo "║  3. sudo systemctl restart spectra   ║"
echo "╚══════════════════════════════════════╝"
