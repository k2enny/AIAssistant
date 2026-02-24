#!/bin/bash
# Linux setup script for AIAssistant
# Installs prerequisites on Debian/Ubuntu-based systems

set -e

echo "🔧 AIAssistant Linux Setup"
echo "=========================="
echo ""

# Check if running as root or with sudo
SUDO=""
if [ "$EUID" -ne 0 ]; then
  SUDO="sudo"
fi

# Update package lists
echo "📦 Updating package lists..."
$SUDO apt-get update -qq

# Install Node.js if not present
if ! command -v node &> /dev/null; then
  echo "📦 Installing Node.js..."
  $SUDO apt-get install -y -qq curl
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO bash -
  $SUDO apt-get install -y -qq nodejs
else
  NODE_VERSION=$(node --version)
  echo "✅ Node.js already installed: $NODE_VERSION"
fi

# Install build essentials (for native modules like better-sqlite3)
echo "📦 Installing build essentials..."
$SUDO apt-get install -y -qq build-essential python3

# Install Playwright dependencies
echo "📦 Installing Playwright dependencies..."
$SUDO apt-get install -y -qq \
  libnss3 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libdrm2 \
  libxkbcommon0 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxrandr2 \
  libgbm1 \
  libpango-1.0-0 \
  libcairo2 \
  libasound2 \
  libatspi2.0-0 \
  2>/dev/null || echo "  ⚠️  Some Playwright deps may not be available on this system"

# Install SQLite
echo "📦 Installing SQLite..."
$SUDO apt-get install -y -qq sqlite3

echo ""
echo "✅ Prerequisites installed!"
echo ""
echo "Next steps:"
echo "  1. cd to the AIAssistant directory"
echo "  2. npm install"
echo "  3. npm run build"
echo "  4. ./build/aiassistant setup"
