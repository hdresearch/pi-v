---
name: swarm-coordination
description: Coordinate multi-agent swarms using the full Vers toolkit — swarm spawning, board task tracking, feed observability, and registry discovery. Covers the complete lifecycle from planning through teardown, including recovery from dropped sessions.
---

# Swarm Coordination

This skill covers the complete workflow for coordinating agent swarms on Vers, combining all available tooling:

| Layer | Tools | Purpose |
|-------|-------|---------|
| **Compute** | `vers_swarm_spawn`, `vers_swarm_task`, `vers_swarm_wait`, `vers_swarm_teardown` | Spawn VMs, dispatch work, collect results |
| **Planning** | `board_create_task`, `board_list_tasks`, `board_update_task`, `board_add_note` | Track what needs doing, who's doing it, what's blocked |
| **Observability** | `feed_publish`, `feed_list`, `feed_stats` | See what's happening across the swarm |
| **Discovery** | `registry_list`, `registry_register`, `registry_discover`, `registry_heartbeat` | Find services, track VM lifecycle |

## Prerequisites

- `VERS_INFRA_URL` set to the infra VM address
- Vers API key configured (for VM operations)
- Anthropic API key (for spawned agents)
- A golden image commit ID (from the `vers-golden-vm` skill)

## The Complete Workflow

### Phase 1: Verify Infrastructure

Before doing anything, confirm the infra VM is reachable and check for existing state:

```
# Is the infra VM up?
registry_discover  role: "infra"

# Any agents left from a previous session?
registry_list  status: "running"

# Any unfinished tasks?
board_list_tasks  status: "in_progress"
board_list_tasks  status: "blocked"
```

If you find running workers or in-progress tasks from a previous session, see [Recovery](#recovery) below.

### Phase 2: Plan the Work

Decompose the problem into discrete tasks. Create them ALL on the board before spawning any agents:

```
board_create_task  title: "Task description"  tags: ["group-tag"]  createdBy: "orchestrator"
```

**Why create tasks first?** Because:
- The plan is visible to all agents and humans before any work starts
- If the orchestrator crashes mid-spawn, the board preserves the plan
- Agents can self-assign from the board if needed
- The board becomes the source of truth for what's done vs. remaining

**Tagging conventions:**

| Tag pattern | Purpose |
|-------------|---------|
| `phase-1`, `phase-2` | Sequencing — phase-2 tasks wait for phase-1 |
| `backend`, `frontend` | Domain grouping |
| `critical`, `nice-to-have` | Priority |
| `parallel-ok` | Can be done concurrently |
| `depends:task-3` | Explicit dependency |

### Phase 3: Spawn Agents

Spawn the right number of workers. A good rule: **one agent per independent task** for the current phase.

```
vers_swarm_spawn
  commitId: "golden-abc123"
  count: 3
  labels: ["worker-1", "worker-2", "worker-3"]
  anthropicApiKey: "sk-ant-..."
```

**Naming convention for labels:**
- `worker-N` — generic numbered workers
- `{role}-{N}` — role-specific (e.g., `auditor-1`, `tester-1`)
- `{task-keyword}` — task-specific (e.g., `auth-impl`, `db-migration`)

### Phase 4: Register Agents

Register every spawned agent in the registry. This makes them discoverable and trackable:

```
registry_register
  id: "vm-id-from-spawn"
  name: "worker-1"
  role: "worker"
  address: "vm-id.vm.vers.sh"
  registeredBy: "orchestrator"
```

### Phase 5: Assign Work

For each agent, update the board task and dispatch:

```
# Update board
board_update_task  id: "task-1"  status: "in_progress"  assignee: "worker-1"

# Dispatch the actual work
vers_swarm_task  agentId: "worker-1"  task: "..."
```

**The task prompt should include:**
1. What to do (the actual work)
2. The board task ID (`Your board task is task-1`)
3. Instructions to update the board (`Update your board task status when done`)
4. Instructions to add notes for findings (`Add findings as board notes`)
5. Instructions to publish feed events for significant milestones

Example task prompt:
```
Implement JWT authentication middleware for the Express API.

Your board task is task-1. When you start, it's already marked in_progress.
- Add findings as board notes (type: "finding")
- If you're blocked, update the task to "blocked" and add a blocker note
- When done, update the task to "done" and add a final summary note
- Publish a feed event when complete: feed_publish type: "task_completed"
```

### Phase 6: Monitor

While agents work, periodically check status:

```
# Quick overview
feed_stats
vers_swarm_status

# Detailed checks
board_list_tasks  status: "blocked"      # Anything stuck?
board_list_tasks  status: "done"         # What's finished?
feed_list  type: "error"  limit: 10      # Any errors?
feed_list  limit: 20                     # Recent activity
```

**When to intervene:**
- A task is `blocked` — read the blocker note, decide whether to unblock or reassign
- An agent has been `working` too long — check `vers_swarm_read` for its output
- Multiple `error` events from one agent — it may be stuck in a loop

**Intervention options:**
- Send a steering message via `vers_swarm_task` to redirect
- Update the board task with new instructions in a note
- Tear down a stuck agent and respawn

### Phase 7: Collect Results

Wait for agents to finish:

```
vers_swarm_wait  agentIds: ["worker-1", "worker-2", "worker-3"]  timeoutSeconds: 600
```

Then review:
```
# Read each agent's full output
vers_swarm_read  agentId: "worker-1"
vers_swarm_read  agentId: "worker-2"

# Check the board for summaries and findings
board_list_tasks  tag: "phase-1"
```

### Phase 8: Clean Up

```
# Tear down ephemeral workers
vers_swarm_teardown

# Publish completion
feed_publish  agent: "orchestrator"  type: "milestone"  summary: "Phase 1 complete: 3/3 tasks done"
```

If there are more phases, repeat from Phase 2 with the next batch of tasks.

## Recovery

Sessions can drop — the orchestrator may crash, lose connection, or be interrupted. The board and registry are your recovery tools.

### Picking Up a Dropped Session

```
# 1. What agents are still running?
registry_list  role: "worker"  status: "running"

# 2. What tasks are in progress?
board_list_tasks  status: "in_progress"

# 3. What tasks are done?
board_list_tasks  status: "done"

# 4. What happened recently?
feed_list  limit: 50
```

From this you can reconstruct the state:
- **In-progress tasks with running agents** — agents are still working, just monitor them
- **In-progress tasks with no running agent** — agent died, reset to `open` and reassign
- **Done tasks** — work completed, move on
- **Open tasks** — not yet started, proceed normally

### Resetting a Stale Task

```
board_update_task  id: "task-3"  status: "open"  assignee: ""
board_add_note     taskId: "task-3"  author: "orchestrator"  content: "Previous agent lost. Resetting for reassignment."  type: "update"
```

### Cleaning Up Orphaned VMs

If you find registered VMs that aren't in your swarm (from a previous session):

```
# Check if they're still responsive
registry_list  status: "running"

# If stale, delete via Vers API
vers_vm_delete  vmId: "orphaned-vm-id"
```

## Conventions

### Agent Naming

| Pattern | Use case |
|---------|----------|
| `orchestrator` | The coordinating meta-agent |
| `worker-{N}` | Generic parallel workers |
| `{domain}-{N}` | Domain-specific (e.g., `backend-1`, `frontend-1`) |
| `reviewer` | Code review agent |
| `tester` | Test-writing agent |

Set the `AGENT_NAME` env var on spawned agents so auto-published feed events use the right name.

### Task Tagging

Always tag tasks with at least:
1. A **phase** tag (`phase-1`, `phase-2`) for sequencing
2. A **domain** tag (`backend`, `frontend`, `infra`) for filtering

### Feed Event Types

Standardize on these event types across your swarm:

| Type | Publisher | When |
|------|-----------|------|
| `agent_started` | (auto) | Agent boots |
| `agent_stopped` | (auto) | Agent exits |
| `task_started` | worker | Picked up a task |
| `task_completed` | worker | Finished a task |
| `task_failed` | worker | Task failed |
| `finding` | worker | Discovered something notable |
| `blocker` | worker | Hit a blocker |
| `error` | any | Unexpected error |
| `decision` | any | Made a significant choice |
| `milestone` | orchestrator | Phase/project milestone |
| `request_review` | worker | Wants review |
| `spawn` | orchestrator | Spawned new agents |
| `teardown` | orchestrator | Tore down agents |

### Heartbeat Convention

For long-running services (not ephemeral workers):

```
# Every 60 seconds
registry_heartbeat  id: "vm-id"
```

When checking for stale VMs, consider anything without a heartbeat in the last 5 minutes as potentially dead.

## Anti-Patterns

**Don't spawn before planning.** Always create board tasks first. If you crash between spawning and assigning, you have running VMs with no purpose.

**Don't skip the registry.** Without registration, orphaned VMs are invisible. Recovery becomes impossible.

**Don't over-parallelize.** More agents ≠ faster results. Each agent adds coordination overhead. Use 2-5 workers for most tasks. Only scale beyond that for embarrassingly parallel work.

**Don't ignore blocked tasks.** A blocked worker is burning compute doing nothing. Check for blockers frequently and either unblock or reassign.

**Don't forget to tear down.** Running VMs cost resources. Tear down workers as soon as their phase is complete. Only keep persistent services.

**Don't have workers spawn sub-workers** unless explicitly needed. Keep the hierarchy flat — one orchestrator, N workers. Deep nesting makes debugging nightmarish.
