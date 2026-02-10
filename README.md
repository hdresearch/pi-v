# pi-v

A [pi](https://github.com/mariozechner/pi-coding-agent) package for [Vers](https://vers.sh) VM orchestration. Provides extensions for managing Firecracker VMs, orchestrating multi-agent swarms, and running background processes — plus skills for golden image creation, platform development, and issue investigation.

## Install

One-liner that checks for pi, installs it if needed, and sets everything up:

```bash
curl -fsSL https://raw.githubusercontent.com/hdresearch/pi-v/main/install.sh | bash
```

Or if you already have pi:

```bash
pi install git@github.com:hdresearch/pi-v.git
```

## Extensions

### vers-vm — VM Lifecycle Management

Core extension for creating, managing, and interacting with Vers Firecracker VMs. When a VM is set as active, pi's built-in tools (`read`, `bash`, `edit`, `write`) are transparently routed through SSH to execute on the VM.

#### Tools

| Tool | Description |
|------|-------------|
| `vers_vms` | List all VMs with IDs, states, and creation times |
| `vers_vm_create` | Create a new root VM. Options: `vcpu_count`, `mem_size_mib`, `fs_size_mib`, `wait_boot` |
| `vers_vm_delete` | Delete a VM by ID |
| `vers_vm_branch` | Clone a VM by branching — creates a new VM with identical state (like `git branch` for VMs) |
| `vers_vm_commit` | Snapshot a VM to a commit ID. Option: `keep_paused` |
| `vers_vm_restore` | Restore a new VM from a previously created commit ID |
| `vers_vm_state` | Pause or resume a VM (`"Paused"` or `"Running"`) |
| `vers_vm_use` | Set a VM as active — all `read`/`bash`/`edit`/`write` calls route to it via SSH |
| `vers_vm_local` | Clear the active VM — tools execute locally again |

#### Tool Overrides

When a VM is active (via `vers_vm_use`), these built-in tools are overridden:

- **`bash`** — Executes commands on the VM via SSH. Supports streaming output. Default timeout: 120s (configurable via `--vers-ssh-timeout` flag). Pass `timeout: 0` to disable.
- **`read`** — Reads files from the VM. Supports `offset`/`limit` for large files. Truncates at 50KB.
- **`edit`** — Edits files on the VM via read-modify-write over SSH. Requires exact text match.
- **`write`** — Writes files to the VM. Creates parent directories automatically.

#### `/vers` Command

Interactive VM dashboard accessible via the `/vers` slash command. Lists VMs, shows active VM, and provides actions: use, exec, branch, commit, pause, resume, delete.

#### SSH Architecture

Communication uses SSH-over-TLS via an `openssl s_client` ProxyCommand to `<vmId>.vm.vers.sh:443`. SSH keys are fetched from the Vers API and cached in `/tmp/vers-ssh-keys/`.

---

### vers-swarm — Multi-Agent Swarm Orchestration

Spawn and manage a swarm of autonomous pi coding agents, each running in its own branched VM. Agents run pi in RPC mode and communicate via a FIFO-based protocol.

#### Concepts

- **Golden image**: A committed VM snapshot with pi, Node.js, and dev tools pre-installed. Agents are spawned by restoring VMs from this commit. See the [vers-golden-vm](#vers-golden-vm) skill.
- **RPC mode**: Each agent runs `pi --mode rpc --no-session` inside a tmux session on its VM. Commands are sent by writing JSON to a FIFO (`/tmp/pi-rpc/in`); events are read from a file (`/tmp/pi-rpc/out`) via `tail -f`.
- **Daemon architecture**: pi runs inside tmux so it survives SSH disconnects. A `sleep infinity` process keeps the FIFO open. The orchestrator's `tail -f` reconnects automatically if the SSH connection drops.
- **Identity**: Each agent gets `/root/.swarm/identity.json` with its `vmId`, `agentId`, `rootVmId`, `depth`, and limits.

#### Tools

| Tool | Description |
|------|-------------|
| `vers_swarm_spawn` | Branch N VMs from a golden commit and start pi agents. Params: `commitId`, `count`, `labels` (optional), `anthropicApiKey`, `model` (optional, default: `claude-sonnet-4-20250514`) |
| `vers_swarm_task` | Send a task prompt to a specific agent by label. The agent works autonomously. |
| `vers_swarm_status` | Check status of all agents — shows idle, working, done, or errored |
| `vers_swarm_read` | Read an agent's accumulated text output. Optional `tail` param for last N characters. |
| `vers_swarm_wait` | Block until specified agents (or all) finish. Returns full output. Default timeout: 300s. |
| `vers_swarm_teardown` | Kill all agents and delete their VMs |

#### Swarm Widget

A TUI widget displays live swarm status with icons: `⟳` working, `✓` done, `✗` error, `○` idle.

#### Agent Lifecycle

1. **Spawn**: VMs are restored from the golden commit, booted, and verified via SSH
2. **Start**: pi launches in RPC mode inside tmux; a startup `get_state` check confirms readiness
3. **Task**: Prompts are sent via `vers_swarm_task`; agent status transitions to `working`
4. **Monitor**: Text output accumulates from `message_update` events; `agent_end` marks completion
5. **Collect**: `vers_swarm_wait` blocks until agents finish, returns all output
6. **Teardown**: Agents are killed and VMs deleted

---

### background-process — Long-Lived Process Management

Run and manage background processes (dev servers, watchers, build processes) that persist across tool calls.

#### Tools

| Tool | Description |
|------|-------------|
| `bg_start` | Start a background process. Params: `id` (unique name), `command`, `cwd` (optional), `waitMs` (optional, ms to capture initial output) |
| `bg_stop` | Stop a process by ID. Optional `signal` param (default: `SIGTERM`, use `SIGKILL` to force) |
| `bg_list` | List all background processes and their status |
| `bg_logs` | Get stdout/stderr from a process. Params: `id`, `last` (recent lines, default 50), `stream` (`stdout`, `stderr`, or `both`) |

---

### plan-mode — Structured Plan-Then-Execute Workflow

Read-only exploration mode for safe code analysis, toggled via `/plan` command or `Ctrl+Alt+P`.

#### Features

- **Plan mode**: Only read-only tools available (`read`, `bash` with safe commands, `grep`, `find`, `ls`)
- **Plan extraction**: Numbered steps extracted from "Plan:" sections in assistant messages
- **Progress tracking**: `[DONE:n]` markers complete plan steps; a widget shows progress
- **Execute mode**: After planning, toggle back to normal mode to execute the plan

---

## Skills

Skills provide specialized instructions that pi loads when a task matches. They're context documents, not code.

| Skill | Description |
|-------|-------------|
| [vers-golden-vm](#vers-golden-vm) | Step-by-step guide to bootstrap a Vers VM into a golden image with pi, Node.js, dev tools, and swarm conventions |
| [vers-platform-development](#vers-platform-development) | Guidelines for Vers platform development — treat Agent Experience (AX) as a product metric, investigate all issues |
| [investigate-vers-issue](#investigate-vers-issue) | Deep investigation checklist for Vers platform issues (API, orchestrator, agent, docs) |
| [contribute-fix](#contribute-fix) | How to contribute bug fixes back to pi-v via fork/PR or GitHub Issues |

### vers-golden-vm

Bootstraps a Vers VM into a reusable golden image for swarm agents. Steps:

1. Create a VM (`vers_vm_create` with 4GB RAM, 8GB disk)
2. Run `scripts/bootstrap.sh` to install Node.js, pi, git, dev tools
3. Copy extensions (`vers-vm.ts`, `vers-swarm.ts`) into the VM
4. Copy `AGENTS.md` context for swarm conventions
5. Initialize `/root/.swarm/` directory structure with identity template and registry
6. Commit the VM (`vers_vm_commit`) to get a golden commit ID

The golden image contains: Ubuntu 24.04, Node.js 22 LTS, pi, git, ripgrep, fd, jq, tree, python3, build-essential.

### vers-platform-development

Philosophy: if an agent struggles with the Vers platform, that's a product bug. Covers:

- When to investigate (missing docs, API errors, confusing design, workarounds needed)
- Investigation priority (it's OK to get derailed fixing platform issues)
- Issue reporting templates
- Communication patterns

### investigate-vers-issue

Structured checklist for deep investigation:

- Understand context and reproduce minimally
- Gather evidence (API requests/responses, VM logs, network tests)
- Document with exact reproduction steps
- File detailed GitHub issues

### contribute-fix

Two paths for contributing:

1. **PR**: Fork via `gh repo fork`, create a fix branch, open a PR with description, fix explanation, and testing details
2. **Issue**: If the user prefers not to fork, file a detailed GitHub Issue with findings and proposed diff

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VERS_API_KEY` | Yes | Vers API authentication key. Also reads from `~/.vers/keys.json` as fallback. |
| `VERS_BASE_URL` | No | Override the Vers API base URL (default: `https://api.vers.sh/api/v1`) |

These can also be set via CLI flags: `--vers-api-key`, `--vers-base-url`, `--vers-ssh-timeout`.

### Swarm Agent Environment

When spawning swarm agents, these variables are forwarded to child VMs:

- `ANTHROPIC_API_KEY` — Required for agents to call Claude (passed via `anthropicApiKey` param)
- `VERS_API_KEY` — Forwarded so child agents can manage VMs themselves
- `VERS_BASE_URL` — Forwarded to child agents

---

## Contributing

Found a bug? Have a fix? See [CONTRIBUTING.md](CONTRIBUTING.md). PRs welcome via the standard fork workflow.
