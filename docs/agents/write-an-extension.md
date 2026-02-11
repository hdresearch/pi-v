# I need to write a pi extension

## Minimal extension

Create `~/.pi/agent/extensions/my-extension.ts`:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function myExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "my_tool",
    label: "My Tool",
    description: "What it does — this is sent to the LLM",
    parameters: Type.Object({
      input: Type.String({ description: "What this param is" }),
    }),
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: `Result: ${params.input}` }] };
    },
  });
}
```

Test: `pi -e ./my-extension.ts` or `/reload` in TUI.

## I need to add a tool

```typescript
pi.registerTool({
  name: "tool_name",
  label: "Human Label",
  description: "LLM sees this",
  parameters: Type.Object({
    required: Type.String({ description: "..." }),
    optional: Type.Optional(Type.Number({ description: "..." })),
  }),
  async execute(_id, params, signal, onUpdate, ctx) {
    // params is typed from the schema
    return { content: [{ type: "text", text: "done" }] };
  },
});
```

Return errors as content, don't throw:
```typescript
return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
```

## I need to block dangerous commands

```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName === "bash" && event.input.command.includes("rm -rf")) {
    return { block: true, reason: "Blocked" };
  }
});
```

## I need to inject context before the LLM runs

```typescript
pi.on("before_agent_start", async () => ({
  message: { customType: "my-ctx", content: "Extra context", display: false },
}));
```

## I need to override bash/read/edit/write

Register a tool with the same name. It replaces the built-in:

```typescript
pi.registerTool({
  name: "bash",
  label: "bash",
  description: "Execute bash — routes to VM when active",
  parameters: Type.Object({
    command: Type.String({ description: "Command" }),
    timeout: Type.Optional(Type.Number()),
  }),
  async execute(_id, params) {
    if (activeVmId) return remoteBash(activeVmId, params.command);
    return localBash(params.command);
  },
});
```

## I need state that survives restarts

```typescript
// Save
pi.appendEntry("my-state", { items: [...items] });

// Restore
pi.on("session_start", async (_ev, ctx) => {
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === "my-state") {
      items = (entry as any).data.items;
    }
  }
});
```

## I need to clean up on exit

```typescript
pi.on("session_shutdown", async () => {
  for (const proc of processes.values()) proc.kill();
});
```

## I need a slash command

```typescript
pi.registerCommand("mycmd", {
  description: "Does a thing",
  handler: async (args, ctx) => { ctx.ui.notify("Done", "info"); },
});
```

## I need to show status in the UI

```typescript
ctx.ui.setStatus("my-ext", "Processing...");  // footer
ctx.ui.setWidget("my-ext", ["line 1", "line 2"]);  // above editor
ctx.ui.notify("Done!", "info");  // toast
```

## Parameter types cheat sheet

```typescript
Type.String({ description: "..." })
Type.Number({ description: "..." })
Type.Boolean({ description: "..." })
Type.Optional(Type.String())
Type.Array(Type.String())
Type.Union([Type.Literal("a"), Type.Literal("b")])
```

For string enums that work with Google models:
```typescript
import { StringEnum } from "@mariozechner/pi-ai";
StringEnum(["list", "add"] as const)
```
