#!/bin/bash
# Bootstrap a Vers VM into a golden image for pi swarm agents.
# Run this on the VM (as root).
set -euo pipefail

echo "=== Vers Golden VM Bootstrap ==="

# --- System packages ---
echo "[1/6] Installing system packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  git curl wget build-essential \
  ripgrep fd-find jq tree \
  python3 python3-pip \
  openssh-client \
  ca-certificates gnupg \
  > /dev/null 2>&1

# fd-find installs as fdfind on Ubuntu, symlink it
ln -sf "$(which fdfind)" /usr/local/bin/fd 2>/dev/null || true

# --- Node.js (latest LTS via nodesource) ---
echo "[2/6] Installing Node.js..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs > /dev/null 2>&1
fi
echo "  node $(node --version), npm $(npm --version)"

# --- Pi coding agent ---
echo "[3/6] Installing pi coding agent..."
npm install -g @mariozechner/pi-coding-agent > /dev/null 2>&1
echo "  pi $(pi --version)"

# --- Git config ---
echo "[4/6] Configuring git..."
git config --global user.name "pi-agent"
git config --global user.email "tynan.daly@hdr.is"
git config --global init.defaultBranch main

# --- Workspace and swarm directories ---
echo "[5/6] Setting up directories..."
mkdir -p /root/workspace
mkdir -p /root/.pi/agent/extensions
mkdir -p /root/.pi/agent/context
mkdir -p /root/.swarm/status

# --- Install extensions and context ---
echo "[6/6] Installing extensions and agent context..."
# These get copied by the caller after this script runs

echo ""
echo "=== Bootstrap complete ==="
echo "  Node: $(node --version)"
echo "  npm:  $(npm --version)"
echo "  pi:   $(pi --version)"
echo "  git:  $(git --version)"
echo ""
echo "Next: copy extensions + AGENTS.md, then commit."
