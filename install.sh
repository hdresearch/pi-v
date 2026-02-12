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
# 4. Check for required environment variables
# -----------------------------------------------------------
MISSING=0

if [ -z "${VERS_API_KEY:-}" ] && [ ! -f "$HOME/.vers/keys.json" ]; then
  warn "VERS_API_KEY is not set and ~/.vers/keys.json not found."
  warn "  Get your key from https://vers.sh and add to your shell config:"
  warn "  export VERS_API_KEY=your-key-here"
  MISSING=1
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  warn "ANTHROPIC_API_KEY is not set."
  warn "  Required for spawning swarm agents. Add to your shell config:"
  warn "  export ANTHROPIC_API_KEY=your-key-here"
  MISSING=1
fi

# -----------------------------------------------------------
# Done
# -----------------------------------------------------------
info "Done! Restart pi or run /reload to pick up the new extensions."
printf "\n  Extensions:\n"
printf "    • vers-vm           — Vers VM management\n"
printf "    • vers-vm-copy      — File transfer between local and VMs\n"
printf "    • vers-swarm        — Agent swarm orchestration\n"
printf "    • background-process — Long-lived process management\n"
printf "    • plan-mode         — Read-only exploration mode\n"
printf "\n  Skills:\n"
printf "    • bootstrap-fleet         — Full fleet setup from scratch\n"
printf "    • vers-golden-vm          — Build golden VM images\n"
printf "    • vers-platform-development\n"
printf "    • investigate-vers-issue\n"
printf "    • contribute-fix\n"
printf "    • vers-networking\n"

if [ "$MISSING" -eq 1 ]; then
  printf "\n"
  warn "Some environment variables are missing (see warnings above)."
  warn "Set them in your shell config, then restart pi."
fi

printf "\n  To bootstrap a full agent fleet, start pi and say:\n"
printf "    \"bootstrap Vers agents\"\n\n"
