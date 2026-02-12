---
name: vers-golden-vm
description: Bootstrap a Vers VM into a golden image with pi, Node.js, dev tools, and swarm extensions installed. Creates a committed snapshot that can be branched for self-organizing agent swarms.
---

# Vers Golden VM

Bootstrap a Vers VM into a reusable golden image for pi swarm agents. The golden image includes Node.js, pi, git, dev tools, Vers extensions, and swarm coordination conventions.

## Prerequisites

- Vers extension loaded with valid API key
- An Anthropic API key for child agents

## Steps

### 1. Create a VM

```
vers_vm_create with mem_size_mib=4096, fs_size_mib=8192, wait_boot=true
```

### 2. Bootstrap system packages and pi

Set the VM as active with `vers_vm_use`, then run `scripts/bootstrap.sh` on the VM.

### 3. Copy extensions into the VM

Copy these files from the local machine to the VM:

- `~/.pi/agent/extensions/vers-vm.ts` → `/root/.pi/agent/extensions/vers-vm.ts`
- `~/.pi/agent/extensions/vers-swarm.ts` → `/root/.pi/agent/extensions/vers-swarm.ts`

Use heredoc or scp-over-ssh to transfer file contents.

### 4. Copy agent context

Copy `assets/AGENTS.md` (relative to this skill) to `/root/.pi/agent/context/AGENTS.md` on the VM. This file tells each agent about swarm conventions, status reporting, and self-branching rules.

### 5. Initialize swarm directories

```bash
mkdir -p /root/.swarm/status
echo '{"vms":[]}' > /root/.swarm/registry.json
touch /root/.swarm/registry.lock
```

### 6. Write a template identity file

```bash
cat > /root/.swarm/identity.json << 'EOF'
{
  "vmId": "PLACEHOLDER",
  "agentId": "PLACEHOLDER",
  "rootVmId": "PLACEHOLDER",
  "parentVmId": "PLACEHOLDER",
  "depth": 0,
  "maxDepth": 50,
  "maxVms": 20,
  "createdAt": "PLACEHOLDER"
}
EOF
```

The swarm extension overwrites this with real values when spawning agents.

### 7. Bake infra env vars into the image

If you have an infra VM running agent-services, bake the connection details into `/etc/environment` so all processes (including pi) inherit them — `.bashrc` only works for interactive shells:

```bash
cat >> /etc/environment << EOF
VERS_INFRA_URL=https://<infra_vm_id>.vm.vers.sh:3000
VERS_AUTH_TOKEN=<auth_token>
EOF
```

Replace with actual values. This ensures spawned agents can use board/feed/log/registry tools immediately.

### 8. Commit the golden image

Switch back to local (`vers_vm_local`) and commit:

```
vers_vm_commit with the VM ID
```

Save the returned commit_id. This is your golden image.

## Swarm Conventions

See [swarm-conventions.md](references/swarm-conventions.md) for the full protocol:
- Identity file at `/root/.swarm/identity.json`
- VM registry at `/root/.swarm/registry.json` on root VM
- Status reporting to `/root/.swarm/status/{agentId}.json` on root VM
- Patterns: self-branching, scratchpads, speculative execution, worker pools

## What the Golden Image Contains

- **OS**: Ubuntu 24.04
- **Runtime**: Node.js 22 LTS, npm
- **Agent**: pi coding agent (latest)
- **Tools**: git, ripgrep, fd, jq, tree, python3, build-essential
- **Extensions**: vers-vm.ts (VM management + SSH routing), vers-swarm.ts (swarm orchestration)
- **Context**: AGENTS.md (swarm conventions and self-organization instructions)
- **Swarm**: /root/.swarm/ directory structure with identity template and registry
