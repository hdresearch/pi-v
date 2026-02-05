# Swarm Conventions

## Identity

Every agent in the swarm has a `/root/.swarm/identity.json`:

```json
{
  "vmId": "my-vm-id",
  "agentId": "alice",
  "rootVmId": "root-vm-id",
  "parentVmId": "parent-vm-id",
  "depth": 1,
  "maxDepth": 50,
  "maxVms": 20,
  "createdAt": "2026-02-05T21:00:00Z"
}
```

- `rootVmId`: The top-level orchestrator. All status reporting flows here.
- `parentVmId`: The agent that spawned you. Report results here.
- `depth`: Your level in the tree. Root is 0.
- `maxDepth`: Hard cap on nesting. Do not spawn children if depth >= maxDepth.
- `maxVms`: Soft budget for total VMs in the swarm. Check registry before spawning.

## VM Registry

The root VM maintains a registry at `/root/.swarm/registry.json`:

```json
{
  "vms": [
    { "vmId": "...", "agentId": "alice", "parentVmId": "...", "role": "agent", "status": "working" },
    { "vmId": "...", "agentId": "scratchpad-1", "parentVmId": "...", "role": "scratchpad", "status": "running" }
  ]
}
```

Before creating a VM, agents MUST:
1. SSH into rootVmId
2. Read `/root/.swarm/registry.json`
3. Check total VM count against maxVms
4. If under budget, append your new VM entry and write the file back
5. If at budget, do not create — do the work yourself

Use `flock /root/.swarm/registry.lock` for atomic updates.

## Status Reporting

Each agent writes status to the ROOT VM at `/root/.swarm/status/{agentId}.json`:

```json
{
  "agentId": "alice",
  "vmId": "...",
  "status": "working|done|error",
  "task": "description of what I was asked to do",
  "summary": "what I accomplished or what went wrong",
  "artifacts": ["/root/workspace/output.js"],
  "children": ["alice-sub-1", "alice-sub-2"],
  "updatedAt": "2026-02-05T21:30:00Z"
}
```

Write status updates when:
- Starting work (status: "working")
- Finishing (status: "done", include summary + artifacts)
- Encountering errors (status: "error", include summary)

## Patterns

### Self-branching

When your task is complex enough to benefit from parallelism:

1. Check depth < maxDepth and VM budget
2. `vers_vm_commit` your current VM to snapshot your state
3. `vers_vm_restore` from that commit for each sub-agent
4. Write identity.json into each child with depth+1
5. Start pi in each child, dispatch tasks
6. Wait for children to report done via status files
7. Collect results and continue

### Scratchpad VM

For shared state between siblings:

1. Create a bare VM (vers_vm_create)
2. Register it with role "scratchpad" in the registry
3. Write shared files to it (plans, queues, results)
4. Tell siblings the vmId so they can SSH in to read/write
5. No pi needed — it's just a filesystem

### Speculative execution

When you're unsure which approach is better:

1. Branch yourself twice
2. Give each branch a different strategy
3. Wait for both to finish
4. Evaluate results, pick the winner
5. Delete the loser, continue with winner's state

### Worker pool

For embarrassingly parallel tasks (e.g., process N files):

1. Create a scratchpad VM with a work queue:
   - `/root/queue/pending/file1.json`, `file2.json`, ...
   - `/root/queue/in-progress/`
   - `/root/queue/done/`
2. Spawn N worker agents
3. Each worker: atomically move a file from pending to in-progress, process, move to done
4. Coordinator polls done/ directory until all work is complete

## Rules

1. ALWAYS check VM budget before creating VMs
2. ALWAYS report status to root VM when starting and finishing
3. ALWAYS clean up VMs you created when done (delete children)
4. Be JUDICIOUS about branching — only branch when parallelism provides clear benefit
5. Prefer doing work yourself over spawning a sub-agent for trivial tasks
6. When in doubt, do the work sequentially
