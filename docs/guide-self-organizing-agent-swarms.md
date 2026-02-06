# Building Self-Organizing Agent Swarms with Pi and Vers

> Parallelize complex coding tasks across Firecracker VMs using an architect-worker pattern. One agent decomposes the work, spawns parallel workers on branched VMs, and assembles a working result — full-stack apps built in under 60 seconds.

## The Challenge

You have a coding agent that can build anything — but it builds sequentially. A full-stack app with a server, client, and landing page takes 10-15 minutes because the agent writes one file at a time. The bottleneck isn't the LLM's speed. It's the serial execution.

You might consider a few approaches:

**Option A: One agent, one task.** Send the full spec and let a single agent build everything. This works, but a multiplayer game with WebSocket server, Canvas client, and styled landing page takes 12+ minutes. Every file is blocked on the previous one.

**Option B: Manual parallelism.** Open multiple terminal tabs, start separate agents, manually split the work, then copy files between them. This is faster, but the coordination overhead falls on you. You become the message bus.

**Option C: Shared workspace, multiple agents.** Run several agents in the same directory. They step on each other's files. Git conflicts. Race conditions. Chaos.

The problem is that parallelism requires isolation — each agent needs its own filesystem — but isolation breaks coordination. You need both.

## What You're Building

By the end of this guide, you'll have:

- A **golden VM image** with pi and all tools pre-installed, snapshotted and ready to branch
- An **architect agent** that autonomously decomposes tasks, spawns workers, and integrates results
- **Parallel worker agents** running on branched VMs, each building against a shared spec
- A working full-stack app built by the swarm in ~60 seconds
- The infrastructure to reuse this pattern for any multi-component project

## Before You Start

You'll need:

- [Pi coding agent](https://github.com/badlogic/pi-mono) installed (`npm install -g @mariozechner/pi-coding-agent`)
- A [Vers](https://vers.sh) account with API key (`VERS_API_KEY` environment variable)
- An Anthropic API key (`ANTHROPIC_API_KEY`)
- `ssh` and `openssl` on your PATH

Install the Vers extensions:

```bash
pi install git@github.com:hdresearch/pi-v.git
```

This gives you the `vers_vm_*` tools for VM management and `vers_swarm_*` tools for orchestration.

## The Plan

- **Understand the pattern**: Why an architect-worker decomposition solves the serial bottleneck
- **Build the golden image**: A snapshotted VM that boots in seconds with everything pre-installed
- **Write the architect prompt**: The single prompt that drives the entire swarm
- **Run the swarm**: Watch an architect spawn workers and build a real project
- **Handle production concerns**: What breaks, how to fix it, and when not to use swarms

## The Architect-Worker Pattern

The core insight: coding agents are good at building one well-scoped component against a clear spec. They're bad at holding an entire system in their head while context-switching between files. So don't make them.

### Without the pattern

A single agent builds a multiplayer game:

```
Agent: "I'll start with the server..."
  → writes server.js (3 min)
Agent: "Now the client..."
  → writes game.js (4 min)
  → references server message format from memory (sometimes wrong)
Agent: "Now the landing page..."
  → writes index.html (3 min)
  → uses CSS classes that don't match the game's DOM
Agent: "Let me fix the integration issues..."
  → 2 more minutes of patches
Total: ~12 minutes, 1 agent
```

The agent holds everything in context. By the time it writes the client, the server's exact message format is 3 minutes of context ago. Drift happens.

### With the pattern

An architect agent coordinates three workers:

```
Architect: "I'll write the spec first."
  → writes SPEC.md with message types, CSS classes, DOM IDs (30 sec)
Architect: "Spawning 3 workers from golden image..."
  → branches 3 VMs in parallel (5 sec)
Architect: "Tasking each worker with the full spec..."
  → server worker builds server.js (45 sec)  ─┐
  → client worker builds game.js (50 sec)     ─┼─ parallel
  → landing worker builds index.html (40 sec) ─┘
Architect: "Collecting files, fixing integration..."
  → reads files from each VM, writes to own VM
  → fixes: server sends `segments`, client reads `snake` → patch
  → npm install && node server.js → works
Total: ~90 seconds, 4 agents
```

The spec is the contract. Workers never communicate with each other. All coordination flows through the spec (upfront) and the architect (after). This is the same pattern as a tech lead writing a design doc, delegating components, then doing code review.

### Why the spec matters

Workers run on separate VMs with separate filesystems. They can't read each other's code. The only information they share is the spec embedded in their task prompt. If the spec says the WebSocket message format is `{ type: "state", snakes: [...], food: {x, y} }`, all three workers build against that contract.

Without a spec, workers invent their own conventions. The server sends arrays, the client expects objects. The landing page uses `.card` classes, the game uses `.game-card`. The architect spends more time fixing mismatches than the workers spent building.

A good spec defines: message/API types with exact field names, shared constants (grid size, port, tick rate), CSS class names and DOM IDs, and file structure (what each worker produces).

## Step 1: Build the Golden Image

The golden image is a Vers VM snapshot with Node.js, pi, git, and extensions pre-installed. Branching from it creates a ready-to-code VM in seconds instead of minutes.

Create a VM and bootstrap it:

```bash
# In pi, create a VM with enough resources
vers_vm_create --mem_size_mib 4096 --fs_size_mib 8192 --wait_boot true
```

Set the VM as active and run the bootstrap:

```bash
vers_vm_use --vmId <your-vm-id>
```

```bash
# Install system packages
apt-get update -qq
apt-get install -y -qq git curl wget build-essential ripgrep jq tree python3 openssh-client ca-certificates gnupg

# Install Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y -qq nodejs

# Install pi
npm install -g @mariozechner/pi-coding-agent

# Configure git
git config --global user.name "pi-agent"
git config --global user.email "pi-agent@vers.sh"

# Create workspace and swarm directories
mkdir -p /root/workspace /root/.swarm/status
echo '{"vms":[]}' > /root/.swarm/registry.json
```

Copy the Vers extensions into the VM so child agents have the same tools:

```bash
# From local, copy extensions to the VM
vers_vm_copy --localPath ~/.pi/agent/git/github.com/hdresearch/pi-v/extensions/vers-vm.ts \
             --remotePath /root/.pi/agent/extensions/vers-vm.ts --direction to_vm
vers_vm_copy --localPath ~/.pi/agent/git/github.com/hdresearch/pi-v/extensions/vers-swarm.ts \
             --remotePath /root/.pi/agent/extensions/vers-swarm.ts --direction to_vm
```

Switch back to local and snapshot:

```bash
vers_vm_local
vers_vm_commit --vmId <your-vm-id>
```

Save the returned `commit_id`. This is your golden image. Every future swarm branches from it.

## Step 2: Write the Architect Prompt

The architect prompt is the single input that drives the entire build. It contains the goal, the swarm instructions, and the credentials.

Here's the template:

```
You are the ARCHITECT. Build [GOAL].

## What to build
[Detailed requirements — features, tech stack, interactions]

## Requirements
[Concrete, testable requirements as bullet points]

## HOW TO DO THIS — Use the swarm!

### Step 1: Design
Write /root/workspace/SPEC.md defining:
- Message/API protocol (exact field names, types)
- Shared constants (port, grid size, tick rate)
- File structure (what each worker produces)
- Integration points (CSS classes, DOM IDs, event names)

### Step 2: Spawn workers
Use `vers_swarm_spawn` with commit ID `GOLDEN_IMAGE_COMMIT_ID`.
Spawn 3 workers: ["server", "client", "landing"]

### Step 3: Task each worker
Use `vers_swarm_task` for each. INCLUDE THE FULL SPEC in each task.
Workers are on separate VMs — they cannot read your files.

### Step 4: Wait and collect
Use `vers_swarm_wait` to block until all workers finish.
Then `vers_vm_use` each worker VM, `read` their files, `vers_vm_local` between reads.

### Step 5: Assemble and verify
Write all files to /root/workspace/ on YOUR VM.
Fix any integration mismatches.
Run: npm install && node server.js

### Anthropic API key: sk-ant-...
### Golden image commit: abc123...
```

The key details: the spec must be **embedded in every task prompt**, not referenced by path. Workers can't read the architect's filesystem. And the architect must fix integration issues after collecting — workers will drift from the spec.

## Step 3: Spawn and Run the Swarm

Start the swarm by spawning a single architect agent:

```bash
vers_swarm_spawn --commitId <golden-image-commit> --count 1 --labels '["architect"]' \
                 --anthropicApiKey <your-key>
```

Then send it the architect prompt:

```bash
vers_swarm_task --agentId architect --task "<your architect prompt>"
```

Wait for completion:

```bash
vers_swarm_wait
```

What happens behind the scenes:

1. The swarm extension restores a VM from the golden image
2. Pi starts in RPC mode inside a tmux session on the VM
3. A FIFO + tail-based protocol handles command/event streaming over SSH
4. The architect receives the prompt and starts working
5. The architect calls `vers_swarm_spawn` itself, branching 3 more VMs
6. Each worker receives a task with the full spec embedded
7. Workers build in parallel (~45-60 seconds)
8. The architect collects files via `vers_vm_use`, fixes mismatches, assembles, and verifies

The architect is autonomous — you send one prompt and walk away.

## Step 4: Serve the Result

Vers VMs are accessible at `https://{vmId}.vm.vers.sh:{port}`. TLS terminates at the Vers proxy — your VM serves plain HTTP. Ports 3000 and 8080 are routed.

If your server binds to `0.0.0.0` (IPv4 only), the Vers proxy can't reach it because it connects over IPv6. You need a bridge:

```javascript
// proxy.js — IPv6 listener forwarding to IPv4 server
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

// Handle WebSocket upgrades
server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(3000, "127.0.0.1", () => {
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
    upstream.write(Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n"));
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

Run this alongside your server, and the app is live at `https://{vmId}.vm.vers.sh:8080`.

> Better approach: tell your server to bind `::` (IPv6 dual-stack) directly. Most Node.js HTTP servers support this with `server.listen(3000, "::")`, eliminating the need for a bridge entirely.

## Production Concerns

### Workers drift from the spec

Despite receiving the full spec, workers sometimes invent their own field names. The server sends `segments`, the client reads `snake`. The architect's integration-fix step catches this — it reads all produced code, identifies mismatches, and patches them. This is the most valuable step in the pattern.

Mitigation: write specs with extreme precision. Not "the server sends snake data" but "the server sends `{ type: 'state', snakes: Array<{ id: string, segments: Array<[number, number]> }> }`."

### SSH drops don't kill agents

The swarm extension runs pi inside tmux on each VM. If the SSH connection used for event streaming drops (network hiccup, laptop sleep), pi keeps running. The extension automatically reconnects `tail -f` and skips already-processed lines. No work is lost.

### When not to use swarms

Swarms add overhead: VM boot time, SSH latency, integration fixing. They're slower than a single agent for:

- Small tasks (under 3 files)
- Tightly coupled code where every file depends on every other file
- Tasks where the spec can't be defined upfront (exploratory work, debugging)

The sweet spot: 3 workers building genuinely independent components against a clear contract. A server, a client, and a landing page. A CLI, a library, and tests. An API, a worker, and a dashboard.

### Scaling beyond 3 workers

More workers means more integration surface area. With 5+ workers, the architect spends more time fixing mismatches than the workers spent building. Keep workers at 3 unless components are truly independent (e.g., processing N files in a worker pool pattern).

### Cleanup

Always tear down swarm VMs when done:

```bash
vers_swarm_teardown
```

Or delete VMs individually. Running VMs consume resources even when idle.

## What You Just Built

**Architecture:**
- Golden VM image that branches into ready-to-code environments in seconds
- Architect-worker pattern where one agent decomposes, delegates, and integrates
- Spec-driven coordination — no shared filesystem, no message passing, just a contract
- Resilient SSH streaming that survives connection drops

**Implementation:**
- `vers-vm.ts` extension routing pi's tools through SSH to any VM
- `vers-swarm.ts` extension managing agent lifecycle via tmux daemons on VMs
- Identity and registry conventions for self-organizing agents
- IPv6 bridge pattern for serving apps from Vers VMs

The pattern is reusable. Change the architect prompt, keep the infrastructure. A multiplayer game, a distributed AI system, a documentation site — the decomposition changes, the machinery doesn't.

## If You Get Stuck

- [Pi coding agent docs](https://github.com/badlogic/pi-mono) — extensions, RPC mode, SDK
- [Vers platform](https://vers.sh) — VM management, API reference
- [pi-v repository](https://github.com/hdresearch/pi-v) — extensions source, skills, bootstrap scripts
- [Architect pattern skill](https://github.com/hdresearch/pi-v/blob/main/skills/architect-pattern/SKILL.md) — prompt templates, design principles, tested examples
