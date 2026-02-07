#!/usr/bin/env bash
set -euo pipefail

REPO="git@github.com:hdresearch/pi-v.git"
PI_PKG="@mariozechner/pi-coding-agent"

info()  { printf "\033[1;34m==>\033[0m %s\n" "$*"; }
warn()  { printf "\033[1;33m==>\033[0m %s\n" "$*"; }
error() { printf "\033[1;31m==>\033[0m %s\n" "$*"; exit 1; }

# -----------------------------------------------------------
# 1. Check for Node.js
# -----------------------------------------------------------
if ! command -v node &>/dev/null; then
  error "Node.js is required but not installed. Install it from https://nodejs.org or via nvm."
fi

NODE_MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 20 ]; then
  error "Node.js >= 20 is required (found v$(node --version)). Please upgrade."
fi

# -----------------------------------------------------------
# 2. Check for pi / install if missing
# -----------------------------------------------------------
if command -v pi &>/dev/null; then
  info "pi is already installed ($(pi --version 2>/dev/null || echo 'unknown version'))"
else
  info "Installing pi ($PI_PKG)..."
  npm install -g "$PI_PKG"
  if ! command -v pi &>/dev/null; then
    error "pi installed but not found on PATH. Make sure your npm global bin is in PATH."
  fi
  info "pi installed ($(pi --version 2>/dev/null))"
fi

# -----------------------------------------------------------
# 3. Install the pi-v package
# -----------------------------------------------------------
info "Installing pi-v package from $REPO..."
pi install "$REPO"

# -----------------------------------------------------------
# 4. Install extension dependencies
# -----------------------------------------------------------
PI_V_DIR="$HOME/.pi/agent/git/github.com/hdresearch/pi-v"

if [ -d "$PI_V_DIR/extensions/browser" ]; then
  info "Installing browser extension dependencies..."
  (cd "$PI_V_DIR/extensions/browser" && npm install)
fi

# -----------------------------------------------------------
# Done — list what was actually installed
# -----------------------------------------------------------
info "Done! Restart pi or run /reload to pick up the new extensions."

printf "\n  Extensions:\n"
for ext in "$PI_V_DIR"/extensions/*; do
  [ -e "$ext" ] || continue
  name=$(basename "$ext" .ts)
  printf "    • %s\n" "$name"
done

printf "\n  Skills:\n"
for skill in "$PI_V_DIR"/skills/*; do
  [ -d "$skill" ] || continue
  printf "    • %s\n" "$(basename "$skill")"
done
printf "\n"
