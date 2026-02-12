#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/hdresearch/pi-v"
PI_PKG="@mariozechner/pi-coding-agent"
VERS_API="https://vers.sh"

info()  { printf "\033[1;34m==>\033[0m %s\n" "$*"; }
warn()  { printf "\033[1;33m==>\033[0m %s\n" "$*"; }
error() { printf "\033[1;31m==>\033[0m %s\n" "$*"; exit 1; }
ok()    { printf "\033[1;32m==>\033[0m %s\n" "$*"; }

# Detect shell config file
detect_shell_rc() {
  if [ -f "$HOME/.zshrc" ]; then
    echo "$HOME/.zshrc"
  elif [ -f "$HOME/.bashrc" ]; then
    echo "$HOME/.bashrc"
  else
    echo "$HOME/.bashrc"
  fi
}

# Append an export to shell config (idempotent)
persist_env() {
  local var_name="$1" var_value="$2" shell_rc="$3"
  if ! grep -q "^export ${var_name}=" "$shell_rc" 2>/dev/null; then
    echo "export ${var_name}=${var_value}" >> "$shell_rc"
  else
    # Update existing value
    sed -i.bak "s|^export ${var_name}=.*|export ${var_name}=${var_value}|" "$shell_rc"
    rm -f "${shell_rc}.bak"
  fi
  export "${var_name}=${var_value}"
}

# Find the user's SSH public key
find_ssh_public_key() {
  for key_file in "$HOME/.ssh/id_ed25519.pub" "$HOME/.ssh/id_ecdsa.pub" "$HOME/.ssh/id_rsa.pub"; do
    if [ -f "$key_file" ]; then
      cat "$key_file"
      return 0
    fi
  done
  return 1
}

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
# 4. Vers account setup
# -----------------------------------------------------------
SHELL_RC=$(detect_shell_rc)

if [ -n "${VERS_API_KEY:-}" ]; then
  ok "VERS_API_KEY is already set"
elif [ -f "$HOME/.vers/keys.json" ]; then
  ok "Vers keys found at ~/.vers/keys.json"
else
  info "No Vers API key found. Let's set one up."
  printf "\n"

  # Find SSH public key
  SSH_PUB_KEY=$(find_ssh_public_key 2>/dev/null || true)
  if [ -z "$SSH_PUB_KEY" ]; then
    info "No SSH key found. Generating one..."
    ssh-keygen -t ed25519 -f "$HOME/.ssh/id_ed25519" -N "" -q
    SSH_PUB_KEY=$(cat "$HOME/.ssh/id_ed25519.pub")
    ok "SSH key generated"
  fi

  # Check if this key is already registered
  VERIFY_RESPONSE=$(curl -sf -X POST "${VERS_API}/api/shell-auth/verify-public-key" \
    -H "Content-Type: application/json" \
    -d "{\"ssh_public_key\": \"${SSH_PUB_KEY}\"}" 2>/dev/null || echo '{"verified":false}')

  ALREADY_VERIFIED=$(echo "$VERIFY_RESPONSE" | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    console.log(d.verified && d.count > 0 ? 'true' : 'false');
  " 2>/dev/null || echo "false")

  if [ "$ALREADY_VERIFIED" = "true" ]; then
    # Key is already registered — extract email and get an API key
    EMAIL=$(echo "$VERIFY_RESPONSE" | node -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      const m = d.matches.find(m => m.is_active && m.public_key_verified) || d.matches[0];
      console.log(m.email);
    " 2>/dev/null)
    ok "SSH key already registered to ${EMAIL}"
  else
    # New user — collect email and register
    printf "  Enter your email: "
    read -r EMAIL
    if [ -z "$EMAIL" ]; then
      error "Email is required to create a Vers account."
    fi

    info "Sending verification email to ${EMAIL}..."
    REGISTER_RESPONSE=$(curl -sf -X POST "${VERS_API}/api/shell-auth" \
      -H "Content-Type: application/json" \
      -d "{\"email\": \"${EMAIL}\", \"ssh_public_key\": \"${SSH_PUB_KEY}\"}" 2>/dev/null || echo '{"error":"request failed"}')

    REG_ERROR=$(echo "$REGISTER_RESPONSE" | node -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      console.log(d.error || '');
    " 2>/dev/null || echo "")

    if [ -n "$REG_ERROR" ]; then
      error "Registration failed: ${REG_ERROR}"
    fi

    printf "\n"
    ok "Verification email sent!"
    info "Check your inbox and click the link. Waiting..."
    printf "\n"

    # Poll for verification (up to 5 minutes)
    VERIFIED=false
    for i in $(seq 1 100); do
      POLL_RESPONSE=$(curl -sf -X POST "${VERS_API}/api/shell-auth/verify-key" \
        -H "Content-Type: application/json" \
        -d "{\"email\": \"${EMAIL}\", \"ssh_public_key\": \"${SSH_PUB_KEY}\"}" 2>/dev/null || echo '{"verified":false}')

      IS_VERIFIED=$(echo "$POLL_RESPONSE" | node -e "
        const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
        console.log(d.verified ? 'true' : 'false');
      " 2>/dev/null || echo "false")

      if [ "$IS_VERIFIED" = "true" ]; then
        VERIFIED=true
        break
      fi

      # Print a dot every 3 seconds to show we're waiting
      printf "."
      sleep 3
    done

    printf "\n"

    if [ "$VERIFIED" != "true" ]; then
      error "Verification timed out. Run this script again after clicking the email link."
    fi

    ok "Email verified!"
  fi

  # Create an API key
  info "Creating API key..."
  API_KEY_RESPONSE=$(curl -sf -X POST "${VERS_API}/api/shell-auth/api-keys" \
    -H "Content-Type: application/json" \
    -d "{\"email\": \"${EMAIL}\", \"ssh_public_key\": \"${SSH_PUB_KEY}\", \"label\": \"pi-v-install\"}" 2>/dev/null || echo '{"error":"request failed"}')

  API_KEY=$(echo "$API_KEY_RESPONSE" | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    if (d.api_key) console.log(d.api_key);
    else if (d.error) { console.error(d.error); process.exit(1); }
    else { console.error('unexpected response'); process.exit(1); }
  " 2>/dev/null)

  if [ -z "$API_KEY" ]; then
    error "Failed to create API key. Response: ${API_KEY_RESPONSE}"
  fi

  # Persist the key
  persist_env "VERS_API_KEY" "$API_KEY" "$SHELL_RC"

  # Also write to ~/.vers/config.json for the vers CLI
  mkdir -p "$HOME/.vers"
  if [ -f "$HOME/.vers/config.json" ]; then
    node -e "
      const fs = require('fs');
      const c = JSON.parse(fs.readFileSync('$HOME/.vers/config.json','utf8'));
      c.api_key = '$API_KEY';
      c.versApiKey = '$API_KEY';
      fs.writeFileSync('$HOME/.vers/config.json', JSON.stringify(c, null, 2));
    " 2>/dev/null
  else
    echo "{\"api_key\": \"${API_KEY}\", \"versApiKey\": \"${API_KEY}\"}" > "$HOME/.vers/config.json"
  fi

  ok "VERS_API_KEY saved to ${SHELL_RC} and ~/.vers/config.json"
fi

# -----------------------------------------------------------
# 5. Check for Anthropic API key
# -----------------------------------------------------------
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  ok "ANTHROPIC_API_KEY is already set"
else
  printf "\n"
  warn "ANTHROPIC_API_KEY is not set."
  printf "  Required for spawning swarm agents.\n"
  printf "  Enter your Anthropic API key (or press Enter to skip): "
  read -r ANTHROPIC_KEY
  if [ -n "$ANTHROPIC_KEY" ]; then
    persist_env "ANTHROPIC_API_KEY" "$ANTHROPIC_KEY" "$SHELL_RC"
    ok "ANTHROPIC_API_KEY saved to ${SHELL_RC}"
  else
    warn "Skipped. Add it later: export ANTHROPIC_API_KEY=your-key-here"
  fi
fi

# -----------------------------------------------------------
# Done
# -----------------------------------------------------------
printf "\n"
ok "Setup complete!"
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
printf "\n  To get started, run pi and say:\n"
printf "    \"bootstrap Vers agents\"\n\n"
