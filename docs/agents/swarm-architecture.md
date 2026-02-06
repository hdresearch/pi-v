# Swarm Architecture

## Overview

Orchestrate parallel pi agents across Vers VMs. One coordinator spawns workers from a golden image, tasks them, waits, collects results.

## Tools

| Tool | Purpose |
|------|---------|
| `vers_swarm_spawn` | Branch N VMs from a commit, start pi RPC agents |
| `vers_swarm_task` | Send a prompt to a specific agent |
| `vers_swarm_wait` | Block until agents finish, return all output |
| `vers_swarm_status` | Check agent statuses |
| `vers_swarm_read` | Read one agent's accumulated output |
| `vers_swarm_teardown` | Kill all agents, delete VMs |

## Typical Flow

```
vers_swarm_spawn(commitId, count=3, labels=["server","client","landing"])
  ↓
vers_swarm_task("server", "Build the WebSocket server. SPEC: ...")
vers_swarm_task("client", "Build the game client. SPEC: ...")
vers_swarm_task("landing", "Build the landing page. SPEC: ...")
  ↓
vers_swarm_wait()
  ↓
vers_vm_use(server_vm) → read files → vers_vm_local
vers_vm_use(client_vm) → read files → vers_vm_local
vers_vm_use(landing_vm) → read files → vers_vm_local
  ↓
Assemble files, fix integration issues, verify
```

## RPC Daemon Architecture

Pi runs as a daemon on each VM, surviving SSH disconnects:

```
tmux session "pi-keeper":  sleep infinity > /tmp/pi-rpc/in   (keeps FIFO open)
tmux session "pi-rpc":     pi --mode rpc --no-session < /tmp/pi-rpc/in >> /tmp/pi-rpc/out
```

- **Send commands**: One-shot SSH, pipe JSON to FIFO via stdin (`cat > /tmp/pi-rpc/in`)
- **Read events**: `tail -f /tmp/pi-rpc/out` over persistent SSH, auto-reconnects on drop
- **Line tracking**: Skip already-processed lines on reconnect
- **Kill**: `tmux kill-session -t pi-rpc && tmux kill-session -t pi-keeper`

## Golden Image

A committed VM snapshot with everything pre-installed:
- Node.js 22, npm, git, ripgrep, jq, tree, python3, build-essential
- Pi coding agent + vers-vm.ts + vers-swarm.ts extensions
- `/root/workspace/` work directory
- `/root/.swarm/` coordination directory

Create with `vers-golden-vm` skill. Branch from commit ID to get instant ready-to-code VMs.

## Agent Identity

Each spawned agent gets `/root/.swarm/identity.json`:

```json
{
  "vmId": "...",
  "agentId": "server",
  "rootVmId": "...",
  "parentVmId": "local",
  "depth": 1,
  "maxDepth": 50,
  "maxVms": 20,
  "createdAt": "..."
}
```

## Architect Pattern

For complex builds, spawn ONE architect that decomposes the work:

1. Architect writes `SPEC.md` (message types, field names, CSS classes, file structure)
2. Architect calls `vers_swarm_spawn` to create workers
3. Architect calls `vers_swarm_task` for each, **embedding full spec in each task**
4. Architect calls `vers_swarm_wait`
5. Architect reads files from worker VMs, fixes integration mismatches, assembles

Workers don't share filesystems. The spec embedded in the task prompt is the only contract.

### Why 3 Workers

- Sweet spot for web projects: server, client, assets/config
- More workers = more integration surface = more mismatches to fix
- ~60 seconds for workers vs 10-15 min single agent

### Common Integration Mismatches

- Server sends `segments`, client reads `snake`
- CSS uses `.landing-card`, HTML uses `.card`
- Server sends `[x, y]`, client expects `{x, y}`
- DOM uses `id="deathReason"`, JS queries `.death-reason`

The architect catches and fixes these during assembly.
