---
name: architect-pattern
description: Self-organizing swarm pattern where one architect agent decomposes complex tasks, spawns parallel workers, and assembles results. Use when building multi-file projects, full-stack apps, or any task that benefits from parallel decomposition.
---

# Architect Pattern

A single "architect" agent acts as tech lead: designs the system, writes a shared spec, spawns parallel worker agents across Vers VMs, waits for them to finish, pulls their output, fixes integration issues, and assembles a working result.

## When to Use

- Building multi-file projects (full-stack apps, games, distributed systems)
- Any task where 3+ components can be built independently against a shared contract
- When you want ~60 second build times instead of 10-15 minutes

## Prerequisites

- Vers swarm extension loaded
- Golden VM commit ID (see `vers-golden-vm` skill)
- Anthropic API key

## The Flow

```
Design (SPEC.md) → Fan-out (spawn workers) → Fan-in (wait) → Integrate (fix mismatches) → Verify
```

### Step 1: Spawn the architect

```
vers_swarm_spawn with commitId=<golden_image>, count=1, labels=["architect"]
```

### Step 2: Task the architect

Send a single prompt containing:
1. The goal (what to build, requirements)
2. Instructions to write SPEC.md first
3. Instructions to spawn workers with `vers_swarm_spawn`
4. Instructions to include the full spec in each worker's task
5. Instructions to wait, collect, fix integration issues, and verify
6. The Anthropic API key and golden image commit ID

Use the prompt template below.

## Prompt Template

```
You are the ARCHITECT. Build [GOAL].

## What to build
[Detailed requirements — be specific about features, tech stack, file structure]

## Requirements
[List concrete requirements: collision detection, auth flow, API endpoints, etc.]

## HOW TO DO THIS — Use the swarm!

You have swarm tools. Decompose and parallelize.

### Step 1: Design
Write /root/workspace/SPEC.md with:
- Protocol/API contract (message types, field names, shared constants)
- File structure (what each worker produces)
- Integration points (CSS classes, DOM IDs, WebSocket events, etc.)

### Step 2: Spawn workers
Use `vers_swarm_spawn` with commit ID `[GOLDEN_IMAGE_COMMIT_ID]`.
Spawn N workers, e.g. labels: ["server", "client", "config"]

### Step 3: Task each worker
Use `vers_swarm_task` for each. INCLUDE THE FULL SPEC in each task so workers build compatible parts.
- **server**: Build [files]. [Responsibilities].
- **client**: Build [files]. [Responsibilities].
- **config**: Build [files]. [Responsibilities].

### Step 4: Wait and collect
Use `vers_swarm_wait` to block until all workers finish.
Then use `vers_vm_use` to switch to each worker VM and `read` their files.
Switch back to your VM with `vers_vm_local` between reads.

### Step 5: Assemble and verify
Write all files to /root/workspace/ on YOUR VM.
Fix any integration mismatches you find.
Run install + verify (e.g. `npm install && node server.js`).

### Your Anthropic API key for spawning:
[API_KEY]

Go!
```

## Critical Design Principles

### Spec is the only contract
Workers don't share a filesystem. The SPEC.md embedded in each task prompt is the only way they coordinate. Make it detailed: field names, message types, CSS classes, DOM IDs, constants.

### 3 workers is the sweet spot
For web projects: server, client, assets/landing. More workers means more integration surface area. Only go beyond 3 if components are truly independent.

### The architect MUST fix integration issues
Workers will drift from the spec. Common mismatches:
- Server sends `segments`, client reads `snake`
- CSS uses `.landing-card`, HTML uses `.card`
- Server sends `[x, y]` arrays, client expects `{x, y}` objects
- DOM uses `id="deathReason"`, JS queries `.death-reason`

The architect's integration-fix step is where the pattern adds the most value.

### Include the full spec in every task
Don't reference a file path — the workers are on different VMs. Paste the entire spec into each worker's task prompt.

## Vers Networking

Vers VMs have specific networking:
- **TLS at the proxy**: `*.vm.vers.sh` connections arrive as HTTPS. VMs serve plain HTTP.
- **IPv6 routing**: The Vers proxy connects to VMs over IPv6. If your server binds IPv4 only (`0.0.0.0`), you need an IPv6→IPv4 bridge.
- **Allowed ports**: 3000, 8080 work. Arbitrary ports (3001, 8443) may not.

### IPv6→IPv4 bridge (when needed)

If the server only listens on IPv4, run this alongside it:

```javascript
// proxy.js — listen on [::]:8080, forward to 127.0.0.1:3000
const http = require("http");
const net = require("net");
const server = http.createServer((req, res) => {
  const proxy = http.request({
    hostname: "127.0.0.1", port: 3000, path: req.url, method: req.method,
    headers: { ...req.headers, "x-forwarded-for": req.socket.remoteAddress }
  }, (proxyRes) => { res.writeHead(proxyRes.statusCode, proxyRes.headers); proxyRes.pipe(res); });
  req.pipe(proxy);
});
server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(3000, "127.0.0.1", () => {
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
    upstream.write(Object.entries(req.headers).map(([k,v]) => `${k}: ${v}`).join("\r\n"));
    upstream.write(`\r\nx-forwarded-for: ${socket.remoteAddress}\r\n\r\n`);
    upstream.write(head); upstream.pipe(socket); socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy());
});
server.listen(8080, "::");
```

## Tested Examples

### Multiplayer Snake Game
- 1 architect + 3 workers (server, client, landing)
- Workers built in ~58 seconds
- Architect fixed: CSS class mismatches, `segments` vs `snake` field names, DOM ID inconsistencies
- Result: Working WebSocket multiplayer game with Canvas rendering and scoreboard

### Hive Mind (Distributed AI System)
- 1 architect + 3 workers (backend, frontend, worker-process)
- Built a Node.js orchestrator with 5 AI specialist workers and live web UI
- Architect fixed: demo loop conflicts, missing event types, CSS inconsistencies
- Result: Working system where you ask a question and watch 5 AI agents think and pass messages in real-time

## What Breaks

- **Workers ignore parts of the spec**: Despite embedding it, workers sometimes invent their own field names. The architect must catch this.
- **File collection friction**: `vers_vm_use` + `read` for each worker VM works but is verbose. SSH `cat` has quoting issues. Best to use `vers_vm_use`/`read`/`vers_vm_local` cycle.
- **Single large files**: If a worker produces a 500+ line file that needs integration fixes, the architect may struggle to rewrite it. Keep files small.
- **Circular dependencies**: If worker A needs worker B's implementation details (not just the spec), the pattern breaks. The spec must be the complete contract.

## Swarm Extension Internals

The `vers-swarm.ts` extension runs pi as a daemon inside tmux on each VM:
- **tmux session `pi-keeper`**: Holds a FIFO open so pi never gets EOF
- **tmux session `pi-rpc`**: Runs `pi --mode rpc --no-session` reading from the FIFO, writing to a file
- **Commands**: Sent via one-shot SSH, piped through stdin to avoid shell escaping issues
- **Events**: Read via `tail -f` over SSH, with automatic reconnection if the SSH connection drops
- **Resilience**: If SSH drops, pi stays alive in tmux. The tail reconnects and skips already-processed lines.
