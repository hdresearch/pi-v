# Pi Extension API Reference

## Extension Shape

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function myExtension(pi: ExtensionAPI) {
  // register tools, events, commands, flags
}
```

File locations:
- Global: `~/.pi/agent/extensions/*.ts`
- Project: `.pi/extensions/*.ts`
- Hot reload: `/reload` in TUI

## Register a Tool

```typescript
pi.registerTool({
  name: "tool_name",        // snake_case, used in LLM tool calls
  label: "Human Label",     // shown in TUI
  description: "What it does — sent to LLM in system prompt",
  parameters: Type.Object({
    required_param: Type.String({ description: "..." }),
    optional_param: Type.Optional(Type.Number({ description: "..." })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // params is typed from the schema
    // signal: AbortSignal for cancellation
    // onUpdate: stream partial results
    // ctx: ExtensionContext (ui, session, model)
    return {
      content: [{ type: "text", text: "result for LLM" }],
      details: { anything: "for rendering/state" },
    };
  },
});
```

### Parameter Types

```typescript
Type.String({ description: "..." })
Type.Number({ description: "..." })
Type.Boolean({ description: "..." })
Type.Optional(Type.String())
Type.Array(Type.String())
Type.Union([Type.Literal("a"), Type.Literal("b")])

// For Google-compatible string enums:
import { StringEnum } from "@mariozechner/pi-ai";
StringEnum(["list", "add", "remove"] as const)
```

### Return Shape

```typescript
// Success
return { content: [{ type: "text", text: "..." }], details: { ... } };

// Error (LLM sees it and can recover)
return { content: [{ type: "text", text: "Error: ..." }], isError: true };

// Don't throw — throwing crashes the tool call
```

## Events

Subscribe with `pi.on(eventName, handler)`. Handler receives `(event, ctx)`.

### Key Events

| Event | When | Can Return |
|-------|------|------------|
| `session_start` | Pi loads session | — |
| `session_shutdown` | Pi exits | — |
| `before_agent_start` | After user prompt, before LLM | `{ message, systemPrompt }` |
| `agent_start` | LLM loop begins | — |
| `agent_end` | LLM loop ends | — |
| `turn_start` | Each LLM turn begins | — |
| `turn_end` | Each LLM turn ends | — |
| `context` | Before each LLM call | `{ messages }` (modified) |
| `tool_call` | Before tool executes | `{ block: true, reason }` |
| `tool_result` | After tool executes | `{ content, details, isError }` |
| `input` | User input received | `{ action: "continue" \| "transform" \| "handled" }` |

### Common Patterns

**Block dangerous commands:**
```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName === "bash" && event.input.command.includes("rm -rf")) {
    return { block: true, reason: "Blocked" };
  }
});
```

**Inject context:**
```typescript
pi.on("before_agent_start", async () => {
  return {
    message: { customType: "my-ctx", content: "Extra context for LLM", display: false },
  };
});
```

**Filter messages:**
```typescript
pi.on("context", async (event) => {
  return { messages: event.messages.filter(m => !isStale(m)) };
});
```

**Clean up:**
```typescript
pi.on("session_shutdown", async () => { cleanup(); });
```

## Override Built-in Tools

Register a tool with the same name as a built-in (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`). Your implementation replaces it.

```typescript
pi.registerTool({
  name: "bash",  // overrides built-in bash
  label: "bash",
  description: "Execute bash. Routes to VM when active.",
  parameters: Type.Object({
    command: Type.String({ description: "Command" }),
    timeout: Type.Optional(Type.Number()),
  }),
  async execute(_id, params, signal, onUpdate) {
    if (activeVmId) return remoteBash(activeVmId, params.command);
    return localBash(params.command, params.timeout, signal, onUpdate);
  },
});
```

## State

**In-memory (session lifetime):** Module-level variables in closure.

**Persistent (across restarts):**
```typescript
// Save
pi.appendEntry("my-state", { items: [...] });

// Restore on session_start
pi.on("session_start", async (_ev, ctx) => {
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === "my-state") {
      items = entry.data.items;
    }
  }
});
```

## Commands, Flags, Shortcuts

```typescript
pi.registerCommand("mycmd", {
  description: "Does a thing",
  handler: async (args, ctx) => { ctx.ui.notify("Done", "info"); },
});

pi.registerFlag("my-flag", { type: "boolean", default: false });
if (pi.getFlag("my-flag")) { ... }

pi.registerShortcut("ctrl+shift+p", {
  handler: async (ctx) => { toggle(); },
});
```

## UI (ctx.ui)

```typescript
// Dialogs
const choice = await ctx.ui.select("Pick", ["A", "B"]);
const ok = await ctx.ui.confirm("Sure?", "Details");
const text = await ctx.ui.input("Name:");

// Status bar
ctx.ui.setStatus("key", "text");   // show
ctx.ui.setStatus("key", undefined); // clear

// Widget (above editor by default)
ctx.ui.setWidget("key", ["line1", "line2"]);
ctx.ui.setWidget("key", undefined); // clear

// Notification
ctx.ui.notify("message", "info"); // "info" | "warning" | "error"
```

## Truncation

Tools MUST truncate output. Limit: 50KB / 2000 lines.

```typescript
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@mariozechner/pi-coding-agent";

const t = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
if (t.truncated) text += `\n[Truncated: ${t.outputLines}/${t.totalLines} lines]`;
```
