---
name: agent-services
description: Use the board, feed, and registry tools to coordinate agent swarms via vers-agent-services. Covers task management, activity feeds, service discovery, and orchestrator patterns. Use when working with multi-agent systems on Vers.
---

# Agent Services

vers-agent-services provides three coordination primitives for agent swarms running on Vers VMs:

- **Board** — shared task tracking (create, assign, update, annotate tasks)
- **Feed** — activity stream for observability (publish events, read what others did)
- **Registry** — service discovery (register VMs, find services, heartbeat)

These run on an infra VM. Agents interact via the `board_*`, `feed_*`, and `registry_*` tools.

## Prerequisites

The `VERS_INFRA_URL` environment variable must be set to the infra VM address (e.g., `http://10.0.0.5:3000`). If not set, all tools return a helpful error message.

The extension auto-publishes `agent_started` and `agent_stopped` events to the feed — you do NOT need to call `feed_publish` for these.

## Board

The board is a shared task tracker. Every task has an ID, title, status, optional assignee, tags, and notes.

### Creating Tasks

```
board_create_task
  title: "Implement auth middleware"
  description: "Add JWT validation to all /api routes"
  assignee: "agent-2"
  tags: ["backend", "security"]
  createdBy: "orchestrator"
```

Create tasks **before** spawning agents so the work is visible to all participants. Use descriptive titles — agents read the board to understand context.

### Task Statuses

Use these conventional statuses:

| Status | Meaning |
|--------|---------|
| `open` | Not yet started |
| `in_progress` | An agent is actively working on it |
| `blocked` | Cannot proceed (add a note explaining why) |
| `done` | Completed successfully |
| `failed` | Attempted but failed |

### Updating Tasks

When you pick up a task:
```
board_update_task  id: "task-1", status: "in_progress", assignee: "my-agent-name"
```

When you finish:
```
board_update_task  id: "task-1", status: "done"
```

When you're blocked:
```
board_update_task  id: "task-1", status: "blocked"
board_add_note     taskId: "task-1", author: "agent-2", content: "Missing database credentials", type: "blocker"
```

### Adding Notes

Notes are the primary way agents communicate findings on a task. Use the `type` field:

- **finding** — discovered information relevant to the task
- **blocker** — something preventing progress
- **question** — need clarification or a decision
- **update** — progress checkpoint

```
board_add_note
  taskId: "task-1"
  author: "agent-3"
  content: "Found 3 SQL injection vulnerabilities in user.ts — see /tmp/report.md for details"
  type: "finding"
```

### Querying Tasks

List all open tasks:
```
board_list_tasks  status: "open"
```

What's blocked?
```
board_list_tasks  status: "blocked"
```

What's assigned to me?
```
board_list_tasks  assignee: "my-agent-name"
```

Filter by tag:
```
board_list_tasks  tag: "security"
```

## Feed

The activity feed is an append-only event stream. Use it for observability — every significant action should produce a feed event so other agents (and humans) can understand what's happening.

### Auto-Published Events

These happen automatically (no action needed):

- `agent_started` — published when your agent starts
- `agent_stopped` — published when your agent completes

The agent name comes from the `AGENT_NAME` env var or falls back to hostname.

### Publishing Events

For everything else, publish explicitly:

```
feed_publish
  agent: "agent-2"
  type: "task_completed"
  summary: "Finished auth middleware implementation"
  detail: "Added JWT validation, rate limiting, CORS headers. Tests passing."
```

#### Recommended Event Types

| Type | When to publish |
|------|----------------|
| `task_started` | Picked up a task from the board |
| `task_completed` | Finished a task |
| `task_failed` | Task failed (include reason in detail) |
| `finding` | Discovered something noteworthy |
| `error` | Hit an unexpected error |
| `decision` | Made a significant architectural decision |
| `request_review` | Want another agent or human to review work |
| `milestone` | Reached an important checkpoint |

### Reading the Feed

Check what's been happening:
```
feed_list  limit: 20
```

What has a specific agent been doing?
```
feed_list  agent: "agent-1"
```

Filter by event type:
```
feed_list  type: "error"
```

### Feed Statistics

Get an overview of activity:
```
feed_stats
```

Returns counts by agent and by event type — useful for an orchestrator monitoring swarm health.

## Registry

The registry tracks which VMs exist, what role they play, and whether they're alive.

### Registering a VM

When you start a persistent service, register it:

```
registry_register
  id: "vm-abc123"
  name: "auth-service"
  role: "service"
  address: "vm-abc123.vm.vers.sh"
  services: [{"name": "auth-api", "port": 3001}]
  registeredBy: "orchestrator"
```

### Discovering Services

Find VMs by role:
```
registry_discover  role: "worker"
```

List everything:
```
registry_list
```

Filter by status:
```
registry_list  status: "running"
```

### Heartbeats

Send periodic heartbeats to indicate a VM is still alive:
```
registry_heartbeat  id: "vm-abc123"
```

Convention: send a heartbeat every 60 seconds for long-running services. Other agents check `lastHeartbeat` to detect stale entries.

### Standard Roles

| Role | Description |
|------|-------------|
| `infra` | The infra VM running agent-services |
| `orchestrator` | The coordinating agent |
| `worker` | An ephemeral agent doing a task |
| `service` | A persistent VM running a service |
| `scratchpad` | Shared filesystem for inter-agent data |

## Orchestrator Patterns

If you're the orchestrator (meta-agent managing a swarm), here's the recommended workflow:

### 1. Plan the Work

Break the problem into tasks and create them on the board:

```
board_create_task  title: "Implement user model", tags: ["backend", "phase-1"], createdBy: "orchestrator"
board_create_task  title: "Write user API routes", tags: ["backend", "phase-1"], createdBy: "orchestrator"
board_create_task  title: "Add frontend auth flow", tags: ["frontend", "phase-2"], createdBy: "orchestrator"
```

### 2. Spawn Agents

Use the swarm tools to spawn agents from a golden image:

```
vers_swarm_spawn  commitId: "golden-abc", count: 2, labels: ["backend-1", "backend-2"], anthropicApiKey: "..."
```

### 3. Register Agents

Register spawned agents in the registry for discoverability:

```
registry_register  id: "vm-xyz", name: "backend-1", role: "worker", address: "vm-xyz.vm.vers.sh", registeredBy: "orchestrator"
```

### 4. Assign Work

Update board tasks and dispatch:

```
board_update_task  id: "task-1", status: "in_progress", assignee: "backend-1"
vers_swarm_task    agentId: "backend-1", task: "Implement the user model. Your task is board task-1. Update the board when done."
```

Tell each agent its board task ID so it can update status and add notes.

### 5. Monitor Progress

Poll the feed and board periodically:

```
feed_list     limit: 20                   # Recent activity
feed_stats                                # Overview
board_list_tasks  status: "blocked"       # Anything stuck?
board_list_tasks  status: "done"          # Progress check
```

### 6. Collect Results

When agents finish, read their output:

```
vers_swarm_wait  agentIds: ["backend-1", "backend-2"]
```

Then update the board and plan the next phase.

### 7. Clean Up

Tear down ephemeral workers:

```
vers_swarm_teardown
```

Keep persistent services registered for future use.

## Example: End-to-End Orchestration

```
# 1. Verify services are up
registry_discover  role: "infra"

# 2. Create the work plan
board_create_task  title: "Audit auth module for vulnerabilities"  tags: ["security"]  createdBy: "orchestrator"
board_create_task  title: "Audit data module for vulnerabilities"  tags: ["security"]  createdBy: "orchestrator"

# 3. Spawn workers
vers_swarm_spawn  commitId: "golden-img-123"  count: 2  labels: ["auditor-auth", "auditor-data"]  anthropicApiKey: "sk-..."

# 4. Register workers
registry_register  id: "vm-aaa"  name: "auditor-auth"  role: "worker"  address: "vm-aaa.vm.vers.sh"  registeredBy: "orchestrator"
registry_register  id: "vm-bbb"  name: "auditor-data"  role: "worker"  address: "vm-bbb.vm.vers.sh"  registeredBy: "orchestrator"

# 5. Assign tasks
board_update_task  id: "task-1"  status: "in_progress"  assignee: "auditor-auth"
vers_swarm_task    agentId: "auditor-auth"  task: "Security audit of auth module. Board task: task-1. Add findings as notes. Update board status when done."

board_update_task  id: "task-2"  status: "in_progress"  assignee: "auditor-data"
vers_swarm_task    agentId: "auditor-data"  task: "Security audit of data module. Board task: task-2. Add findings as notes. Update board status when done."

# 6. Publish orchestrator event
feed_publish  agent: "orchestrator"  type: "milestone"  summary: "Security audit started with 2 workers"

# 7. Wait for completion
vers_swarm_wait  timeoutSeconds: 600

# 8. Check results
board_list_tasks  tag: "security"
feed_list  type: "finding"

# 9. Clean up
vers_swarm_teardown
feed_publish  agent: "orchestrator"  type: "milestone"  summary: "Security audit complete"
```
