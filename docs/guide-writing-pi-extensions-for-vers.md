# Writing Pi Extensions for Vers

> Build custom pi extensions that integrate with the Vers VM platform. Teach your agent new tools by writing TypeScript modules that register tools, hook into lifecycle events, and manage state — no build step required.

## The Challenge

You want your coding agent to do something pi doesn't do out of the box. Maybe you need it to manage cloud VMs, run browser automation, track background processes, or gate dangerous commands behind confirmations.

You could use bash scripts and wrap everything in `bash` tool calls. But that gives the LLM no structure — it has to remember command syntax, parse output, and maintain state in its head. The result is fragile, verbose, and hard to debug.

You could also build a separate tool and connect it via MCP. But now you have a separate server to deploy and maintain, and the tool can't react to what the agent is doing — it just responds to calls.

Pi's extension system solves this differently. Extensions are TypeScript modules that run inside the agent process. They can register tools with typed parameters, intercept and modify tool calls, inject context before the LLM runs, persist state across sessions, and interact with the user through dialogs and widgets. They load from a file path with zero build step. And because they run in-process, they have access to the full agent lifecycle.

## What You're Building

By the end of this guide, you'll understand:

- How to **register custom tools** the LLM can call, with typed parameters and structured results
- How to **hook into lifecycle events** to intercept tool calls, inject context, and react to agent state changes
- How to **manage state** that persists across sessions and survives restarts
- How to **override built-in tools** to route execution through SSH, containers, or any remote system
- How to **structure real extensions** by examining the actual Vers VM and swarm extensions

## Before You Start

You need:

- [Pi coding agent](https://github.com/badlogic/pi-mono) installed (`npm install -g @mariozechner/pi-coding-agent`)
- Basic TypeScript familiarity
- A text editor

No build tools, no compilation, no bundling. Pi loads `.ts` files directly via [jiti](https://github.com/unjs/jiti).

## The Plan

- **Learn the extension shape**: The factory function, the API surface, where files go
- **Register a tool**: Parameters, execution, results — the core of most extensions
- **Hook into events**: Intercept tool calls, inject context, clean up on shutdown
- **Override built-in tools**: Route `read`, `bash`, `edit`, `write` through SSH or any remote system
- **Examine real extensions**: Walk through the Vers VM extension's architecture

## The Extension Model

A pi extension is a TypeScript file that exports a default function. That function receives `ExtensionAPI` — the handle to everything the extension can do. It's called once when pi loads, and whatever you register persists for the session.

```typescript
// ~/.pi/agent/extensions/my-extension.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  // Register tools, subscribe to events, set up state
}
```

Pi discovers extensions from two places:

| Location | Scope |
|----------|-------|
| `~/.pi/agent/extensions/*.ts` | Global — all projects |
| `.pi/extensions/*.ts` | Project-local — only in this directory |

You can also point to extensions in `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["./extensions/my-extension.ts"],
  "packages": ["git@github.com:user/pi-extensions.git"]
}
```

Extensions are hot-reloaded with `/reload` in the TUI. No restart needed during development.

### What You Can Register

| Method | Purpose |
|--------|---------|
| `pi.registerTool()` | LLM-callable tool with typed parameters |
| `pi.on(event, handler)` | React to agent lifecycle events |
| `pi.registerCommand()` | Slash command (`/mycommand`) |
| `pi.registerShortcut()` | Keyboard shortcut |
| `pi.registerFlag()` | CLI flag (`--my-flag`) |
| `pi.sendMessage()` | Inject messages into the session |
| `pi.appendEntry()` | Persist state across restarts |

### Available Imports

```typescript
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";  // Schema definitions
```

Node.js built-ins work too: `node:child_process`, `node:fs/promises`, `node:path`, etc. No external npm dependencies needed for most extensions.

## Step 1: Register a Tool

Tools are the primary way extensions give the LLM new capabilities. A tool has a name, description, typed parameters, and an execute function.

Here's a minimal tool that fetches a URL:

```typescript
// ~/.pi/agent/extensions/fetcher.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function fetcherExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "fetch_url",
    label: "Fetch URL",
    description: "Fetch a URL and return the response body as text.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
      maxLength: Type.Optional(Type.Number({ description: "Max characters to return (default: 50000)" })),
    }),
    async execute(_toolCallId, params) {
      const { url, maxLength } = params;
      const limit = maxLength ?? 50000;

      const res = await fetch(url, {
        headers: { "User-Agent": "pi-fetcher/1.0" },
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        return { content: [{ type: "text", text: `Error: HTTP ${res.status}` }] };
      }

      let text = await res.text();
      if (text.length > limit) text = text.slice(0, limit) + "\n[truncated]";

      return { content: [{ type: "text", text }] };
    },
  });
}
```

The key parts:

- **`name`**: What the LLM calls. Use `snake_case` — it appears in tool-call JSON.
- **`label`**: Human-readable name shown in the TUI.
- **`description`**: Sent to the LLM in the system prompt. Be specific — this is how the model decides when to use the tool.
- **`parameters`**: TypeBox schema. The LLM generates JSON matching this schema, and pi validates it before calling execute.
- **`execute`**: Receives the validated params, returns `{ content: [{ type: "text", text }] }`.

### The execute signature

```typescript
async execute(
  toolCallId: string,          // Unique ID for this call
  params: Static<TParams>,     // Validated parameters
  signal: AbortSignal | undefined,  // Cancellation
  onUpdate: AgentToolUpdateCallback | undefined,  // Stream progress
  ctx: ExtensionContext,       // UI, session, model access
): Promise<AgentToolResult>
```

You don't need all of these. Most tools only use `params`. But `signal` matters for long-running operations (respect cancellation), and `ctx` gives you UI access:

```typescript
async execute(_id, params, signal, _onUpdate, ctx) {
  ctx.ui.setStatus("my-ext", "Fetching...");
  // ... do work ...
  ctx.ui.setStatus("my-ext", undefined);
  return { content: [{ type: "text", text: "Done" }] };
}
```

### Parameter types

TypeBox provides the schema. Common patterns:

```typescript
import { Type } from "@sinclair/typebox";

Type.String({ description: "..." })
Type.Number({ description: "..." })
Type.Boolean({ description: "..." })
Type.Optional(Type.String())  // Optional parameter
Type.Array(Type.String())     // Array of strings
Type.Union([Type.Literal("a"), Type.Literal("b")])  // Enum
```

For string enums that work with all providers (including Google), use `StringEnum`:

```typescript
import { StringEnum } from "@mariozechner/pi-ai";

StringEnum(["list", "add", "remove"] as const)
```

## Step 2: Hook Into Events

Events let you react to the agent's lifecycle without registering tools. You can intercept tool calls, inject context, modify messages, and clean up resources.

### Intercept dangerous commands

```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName === "bash" && event.input.command?.includes("rm -rf /")) {
    const ok = await ctx.ui.confirm("Dangerous", "Allow rm -rf /?");
    if (!ok) return { block: true, reason: "Blocked by user" };
  }
});
```

Returning `{ block: true }` stops the tool from executing. The LLM sees the reason and adjusts.

### Inject context before each turn

```typescript
pi.on("before_agent_start", async (event) => {
  return {
    message: {
      customType: "my-context",
      content: "[CONTEXT] You are operating inside a Vers VM. Use vers_vm_* tools.",
      display: false,  // Don't show in TUI, but send to LLM
    },
  };
});
```

### Modify the message history

```typescript
pi.on("context", async (event) => {
  // Remove stale context messages from previous modes
  const filtered = event.messages.filter(m => {
    if (m.role === "user" && typeof m.content === "string") {
      return !m.content.includes("[STALE_CONTEXT]");
    }
    return true;
  });
  return { messages: filtered };
});
```

### Clean up on shutdown

```typescript
pi.on("session_shutdown", async () => {
  for (const proc of runningProcesses.values()) {
    proc.kill("SIGTERM");
  }
});
```

### Event lifecycle

The full sequence for a user prompt:

```
input → before_agent_start → agent_start
  → turn_start → context → [LLM responds]
    → tool_call → [tool executes] → tool_result
  → turn_end
  → [repeat turns while LLM calls tools]
→ agent_end
```

Most extensions only need 2-3 events. `session_start` for initialization, `tool_call` for gating, `session_shutdown` for cleanup.

## Step 3: Manage State

Extensions run in-process, so module-level variables persist for the session:

```typescript
export default function (pi: ExtensionAPI) {
  const connections = new Map<string, Connection>();

  pi.registerTool({
    name: "connect",
    // ...
    async execute(_id, params) {
      const conn = await createConnection(params.host);
      connections.set(params.host, conn);
      return { content: [{ type: "text", text: `Connected to ${params.host}` }] };
    },
  });
}
```

For state that survives pi restarts, use `pi.appendEntry()` and reconstruct on `session_start`:

```typescript
export default function (pi: ExtensionAPI) {
  let items: string[] = [];

  pi.on("session_start", async (_event, ctx) => {
    // Reconstruct from session entries
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "my-items") {
        items = (entry as any).data?.items ?? [];
      }
    }
  });

  pi.registerTool({
    name: "add_item",
    // ...
    async execute(_id, params) {
      items.push(params.text);
      pi.appendEntry("my-items", { items: [...items] });
      return { content: [{ type: "text", text: `Added. ${items.length} items.` }] };
    },
  });
}
```

`appendEntry` writes to the session file but doesn't add anything to the LLM's context. It's invisible to the model — purely for extension state.

## Step 4: Override Built-in Tools

This is where extensions get powerful. You can replace `read`, `bash`, `edit`, and `write` with your own implementations. The LLM doesn't know or care — it calls the same tool names, but your code decides what happens.

The Vers VM extension does exactly this. When a VM is active, `bash` runs commands over SSH instead of locally:

```typescript
export default function versVmExtension(pi: ExtensionAPI) {
  let activeVmId: string | undefined;

  // Tool to set the active VM
  pi.registerTool({
    name: "vers_vm_use",
    label: "Use Vers VM",
    description: "Set the active VM. After this, read/bash/edit/write execute on the VM.",
    parameters: Type.Object({
      vmId: Type.String({ description: "VM ID" }),
    }),
    async execute(_id, params) {
      activeVmId = params.vmId;
      return { content: [{ type: "text", text: `Active VM set to ${params.vmId}` }] };
    },
  });

  // Override bash — route to VM when active, local when not
  pi.registerTool({
    name: "bash",
    label: "bash",
    description: "Execute a bash command. Routes to active VM if set.",
    parameters: Type.Object({
      command: Type.String({ description: "Command to execute" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
    }),
    async execute(_id, params, signal, onUpdate) {
      if (!activeVmId) {
        return localBash(params.command, params.timeout, signal, onUpdate);
      }
      // SSH to the VM and run the command
      return remoteBash(activeVmId, params.command, params.timeout, signal, onUpdate);
    },
  });
}
```

The pattern: check a flag or state variable. If set, route to your implementation. If not, fall back to the local behavior. The LLM doesn't know which path runs — it just calls `bash` as usual.

This is how the Vers VM extension routes all four core tools (`read`, `bash`, `edit`, `write`) through SSH when a VM is active. One `vers_vm_use` call transparently changes where everything executes.

## Step 5: Examine a Real Extension

Let's walk through the architecture of the Vers swarm extension, which orchestrates parallel coding agents across VMs.

### State management

The extension maintains two maps — agents and their RPC handles:

```typescript
const agents = new Map<string, SwarmAgent>();
const rpcHandles = new Map<string, RpcHandle>();
```

Each agent has a status (`starting`, `idle`, `working`, `done`, `error`), accumulated output, and a VM ID. The RPC handle wraps the SSH connection used to send commands and receive events.

### The spawn tool

`vers_swarm_spawn` does four things per agent:

1. **Restores a VM** from a golden image commit via the Vers API
2. **Waits for SSH** to become available (retry loop with 2s intervals)
3. **Starts pi in RPC mode** inside a tmux session on the VM
4. **Verifies the agent is ready** by sending a `get_state` RPC command and waiting for a response

The tmux architecture is important. Pi runs inside `tmux new-session -d -s pi-rpc` so it survives SSH disconnects. A separate `sleep infinity` process keeps the FIFO open. Commands are sent via one-shot SSH writes to the FIFO. Events are read via `tail -f` over a persistent SSH connection that automatically reconnects if it drops.

### Multiple tools, shared state

The extension registers six tools that share the `agents` and `rpcHandles` maps:

- `vers_swarm_spawn` — creates VMs and starts agents
- `vers_swarm_task` — sends a prompt to an agent
- `vers_swarm_wait` — blocks until agents finish
- `vers_swarm_status` — returns current state
- `vers_swarm_read` — reads an agent's output
- `vers_swarm_teardown` — kills agents and deletes VMs

Each tool reads and writes the shared maps. The LLM calls them in sequence — spawn, task each agent, wait, read results. The extension maintains the complexity; the LLM just makes tool calls.

### Lifecycle cleanup

```typescript
pi.on("session_shutdown", async () => {
  for (const handle of rpcHandles.values()) {
    try { await handle.kill(); } catch {}
  }
  rpcHandles.clear();
});
```

Every extension that creates resources (processes, connections, VMs) should clean up on shutdown.

### UI feedback

The extension updates a TUI widget showing swarm status:

```typescript
function updateWidget(ctx) {
  const lines = [`─── Swarm (${agents.size}) ───`];
  for (const [id, a] of agents) {
    const icon = a.status === "done" ? "✓" : a.status === "working" ? "⟳" : "○";
    lines.push(`${icon} ${id}: ${a.status}`);
  }
  ctx.ui.setWidget("vers-swarm", lines);
}
```

`setWidget` renders text above (or below) the editor. It updates in real-time as agents report progress.

## Production Concerns

### Output truncation

Tools must truncate output. Pi's built-in limit is 50KB / 2000 lines. Large outputs overflow the LLM's context and degrade performance. Use the built-in helpers:

```typescript
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@mariozechner/pi-coding-agent";

const result = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
if (result.truncated) {
  text += `\n[Truncated: ${result.outputLines} of ${result.totalLines} lines]`;
}
```

### Error handling

Tools should return errors as content, not throw:

```typescript
try {
  const result = await riskyOperation();
  return { content: [{ type: "text", text: result }] };
} catch (err) {
  return {
    content: [{ type: "text", text: `Error: ${err.message}` }],
    isError: true,
  };
}
```

Throwing from `execute` crashes the tool call. Returning `isError: true` lets the LLM see the error and recover.

### Testing during development

Use the `-e` flag for quick iteration:

```bash
pi -e ./my-extension.ts
```

Inside pi, use `/reload` to pick up changes without restarting. Check the extension loaded:

```
/tools          # List active tools — yours should appear
/vers           # If you registered a command
```

### No external dependencies (when possible)

Extensions that use only Node.js built-ins and pi's bundled packages (`@sinclair/typebox`, `@mariozechner/pi-ai`) are self-contained. They work everywhere pi runs — local machines, Vers VMs, CI containers — without `npm install`.

If you need npm dependencies, add a `package.json` next to your extension and run `npm install`. The `node_modules` directory is resolved automatically.

## What You Just Built

**Core patterns:**
- Register tools with typed parameters that the LLM can call
- Hook into lifecycle events to intercept, inject, and clean up
- Persist state across sessions via `appendEntry`
- Override built-in tools to route execution anywhere

**Architecture:**
- Extensions are TypeScript files loaded at runtime — no build step
- Module-level variables persist for the session; `appendEntry` persists across restarts
- Multiple tools in one extension share state through closures
- The LLM doesn't know about routing — it calls the same tool names regardless of where they execute

**The Vers pattern specifically:**
- `vers_vm_use` sets a flag; `bash`/`read`/`edit`/`write` check that flag and route accordingly
- `vers_swarm_spawn` starts pi in tmux on remote VMs, communicates via FIFO + tail
- Shared maps track agent state; lifecycle events handle cleanup

## If You Get Stuck

- [Pi extension docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md) — full API reference, all events, all methods
- [Extension examples](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions) — working implementations for common patterns
- [TypeBox docs](https://github.com/sinclairzx81/typebox) — schema definitions for tool parameters
- [pi-v repository](https://github.com/hdresearch/pi-v) — Vers VM, swarm, background process, plan mode extensions
- [TUI component docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/tui.md) — custom rendering for tools and widgets
