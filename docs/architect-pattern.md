# Architect Pattern

A self-organizing swarm pattern where a single "architect" agent decomposes a complex task, spawns worker agents in parallel, and assembles the result.

## Overview

1. Spawn ONE agent (the architect) with swarm tools and an Anthropic API key
2. Give it a complex build goal in a single prompt
3. The architect designs the system, writes a spec, spawns workers, tasks them, waits, collects, integrates, and verifies — all autonomously

## The Flow

```
User Prompt
    │
    ▼
┌─────────┐
│Architect │──── Step 1: Write SPEC.md (message protocol, constants, file structure)
│ (1 VM)  │
└────┬────┘
     │         Step 2: vers_swarm_spawn (3-5 workers from golden image)
     │
     ├──────────────────┬──────────────────┐
     ▼                  ▼                  ▼
┌─────────┐      ┌─────────┐       ┌─────────┐
│ Worker A │      │ Worker B │       │ Worker C │   Step 3: vers_swarm_task
│ (server) │      │ (client) │       │ (landing)│   (each gets full SPEC.md)
└────┬────┘      └────┬────┘       └────┬────┘
     │                │                  │
     ▼                ▼                  ▼
     └────────────────┼──────────────────┘
                      │
                      ▼                            Step 4: vers_swarm_wait
               ┌─────────┐
               │Architect │──── Step 5: Pull files from worker VMs (vers_vm_use + read)
               │          │──── Step 6: Fix integration mismatches
               │          │──── Step 7: Assemble on own VM
               │          │──── Step 8: npm install + verify server starts
               └──────────┘
```

## Key Principles

### Spec-first design
The architect writes `SPEC.md` before spawning workers. This defines:
- Message/API protocol (JSON message types, field names)
- Shared constants (grid size, port, colors)
- File structure (what each worker produces)
- Integration points (CSS class names, DOM IDs, WebSocket events)

The full spec is included in every worker's task prompt. This is the critical coordination mechanism — without it, workers produce incompatible code.

### Include the spec in every task
Workers don't have access to the architect's filesystem. The spec must be **embedded in the task prompt itself**. This means the task prompt for each worker is large (1-2k tokens of spec + the actual task), but this is the only way to ensure compatibility.

### The architect is a tech lead, not a dispatcher
After workers finish, the architect:
- Reads all produced code
- Identifies integration mismatches (e.g., server sends `segments` but client reads `snake`)
- Fixes CSS class name conflicts, DOM ID mismatches, API field name differences
- Assembles everything into a working whole
- Runs verification (syntax check, npm install, server start)

This integration-fix step is where the pattern adds the most value. Parallel agents will always produce minor incompatibilities; the architect resolves them.

### Fan-out then fan-in
The pattern is strictly: design → fan-out → fan-in → integrate → verify. Workers don't communicate with each other. All coordination goes through the spec (upfront) and the architect (after).

## Prompt Template

```
You are the ARCHITECT. Build [GOAL].

## What to build
[Detailed requirements]

## HOW TO DO THIS — Use the swarm!

### Step 1: Design
Write /root/workspace/SPEC.md with [protocol, constants, file structure].

### Step 2: Spawn workers
Use `vers_swarm_spawn` with commit ID `[GOLDEN_IMAGE_COMMIT]`.
Spawn N workers: ["label1", "label2", "label3"]

### Step 3: Task each worker
Use `vers_swarm_task` for each. INCLUDE THE FULL SPEC in each task.
- **label1**: Build [files]. [Specific responsibilities].
- **label2**: Build [files]. [Specific responsibilities].
- **label3**: Build [files]. [Specific responsibilities].

### Step 4: Wait and collect
Use `vers_swarm_wait`, then `vers_vm_use` to read files from each worker VM.

### Step 5: Assemble and verify
Write all files to /root/workspace/, install deps, verify it runs.

### Your Anthropic API key for spawning:
[API_KEY]

Go!
```

## What Works Well

- **3 workers is the sweet spot** for most web projects (server, client, assets/config)
- **~60 seconds** for workers to build their components (vs 10-15 min single-agent)
- The architect reliably catches integration issues across workers
- Workers produce higher quality code when given a detailed spec
- The `vers_swarm_wait` tool eliminates polling overhead

## What Breaks

- **Workers drift from the spec**: Despite getting the full spec, workers sometimes use different field names or structures. The architect must catch this.
- **File collection is awkward**: The architect needs to `vers_vm_use` to each worker VM, `read` files, then write them locally. SSH `cat` commands also work but have quoting issues.
- **Large codebases**: If a single file exceeds ~500 lines, the architect may struggle to rewrite it during integration. Better to keep files small.
- **Circular dependencies**: If worker A's output depends on worker B's implementation details (not just the spec), the pattern breaks. Keep the spec as the only contract.

## Infrastructure Requirements

- **Golden VM image**: Commit ID for `vers_swarm_spawn`. Must have pi, Node.js, git, and the swarm extensions installed.
- **Anthropic API key**: Passed to the architect, who passes it to workers via `vers_swarm_spawn`.
- **Vers API key**: Automatically propagated by the swarm extension.

## Tested Examples

### Multiplayer Snake Game
- 1 architect + 3 workers (server, client, landing)
- Workers built in ~58 seconds
- Architect fixed: CSS class mismatches, `segments` vs `snake` field names, DOM ID inconsistencies
- Result: Working game with WebSocket multiplayer, Canvas rendering, scoreboard

### Hive Mind (Distributed AI System)
- 1 architect + 3 workers (backend, frontend, workers)
- Built a Node.js orchestrator with 5 AI specialist workers and a live web UI
- Workers call Anthropic API directly, stream results through a WebSocket message bus
- Architect fixed: demo loop conflicts, missing event types, CSS inconsistencies

## Hosting on Vers

Vers VMs have specific networking characteristics:
- **IPv6 only** from the external proxy: The Vers proxy routes to VMs over IPv6
- **TLS termination at the proxy**: All `*.vm.vers.sh` traffic arrives as HTTPS at the browser; the VM receives plain HTTP
- **Allowed ports**: 3000, 8080 (not arbitrary ports like 3001)
- **IPv4 servers need a bridge**: If your server binds to `0.0.0.0` (IPv4), you need a lightweight proxy on `[::]:8080` forwarding to `127.0.0.1:3000`

Simple IPv6→IPv4 bridge (Node.js):
```javascript
const http = require("http");
const net = require("net");

const server = http.createServer((req, res) => {
  const proxy = http.request({
    hostname: "127.0.0.1", port: 3000,
    path: req.url, method: req.method,
    headers: { ...req.headers, "x-forwarded-for": req.socket.remoteAddress }
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  req.pipe(proxy);
});

server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(3000, "127.0.0.1", () => {
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
    upstream.write(Object.entries(req.headers).map(([k,v]) => `${k}: ${v}`).join("\r\n"));
    upstream.write(`\r\nx-forwarded-for: ${socket.remoteAddress}\r\n\r\n`);
    upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(8080, "::");
```
