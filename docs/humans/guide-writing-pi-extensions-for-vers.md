# Write a Pi Extension That Manages Vers VMs

> Build a pi extension from scratch that creates Vers VMs, runs commands on them over SSH, and transparently routes the agent's tools to remote machines. You'll have a working extension in 15 minutes.

## What You'll Have at the End

- A pi extension that creates and manages Vers VMs
- SSH command execution from within the agent
- Transparent tool routing — the LLM calls `bash` as usual, your extension decides where it runs
- The pattern for building any integration extension

## Before You Start

```bash
npm install -g @mariozechner/pi-coding-agent
```

You need: a [Vers](https://vers.sh) account with `VERS_API_KEY` env var set, and `ssh`/`openssl` on your PATH.

## Step 1: Create the Extension File

Create `~/.pi/agent/extensions/my-vers.ts`:

```typescript
// ~/.pi/agent/extensions/my-vers.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";

export default function myVersExtension(pi: ExtensionAPI) {
  // we'll fill this in step by step
}
```

Test it loads: `pi -e ~/.pi/agent/extensions/my-vers.ts`. You should see pi start with no errors. `/reload` picks up changes without restarting.

## Step 2: Add a Tool to Create VMs

Inside the default function, register your first tool:

```typescript
// ~/.pi/agent/extensions/my-vers.ts
export default function myVersExtension(pi: ExtensionAPI) {
  const API_KEY = process.env.VERS_API_KEY || "";
  const BASE = "https://api.vers.sh/api/v1";

  async function versApi(method: string, path: string, body?: unknown) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Vers API ${res.status}: ${await res.text()}`);
    return res.headers.get("content-type")?.includes("json") ? res.json() : undefined;
  }

  pi.registerTool({
    name: "create_vm",
    label: "Create VM",
    description: "Create a new Vers VM",
    parameters: Type.Object({
      wait_boot: Type.Optional(Type.Boolean({ description: "Wait for boot (default: true)" })),
    }),
    async execute(_id, params) {
      const q = (params.wait_boot ?? true) ? "?wait_boot=true" : "";
      const result = await versApi("POST", `/vm/new_root${q}`, {
        vm_config: { mem_size_mib: 4096, fs_size_mib: 8192 },
      });
      return { content: [{ type: "text", text: `VM created: ${result.vm_id}` }] };
    },
  });
}
```

Reload pi (`/reload`), then ask the agent to create a VM. It calls your `create_vm` tool and you get back a VM ID.

## Step 3: Add SSH Execution

Now add a tool that runs commands on a VM. Vers VMs use SSH over TLS on port 443:

```typescript
  // Add inside myVersExtension, after the versApi function:

  async function getKeyPath(vmId: string): Promise<string> {
    const info = await versApi("GET", `/vm/${vmId}/ssh_key`);
    const path = `/tmp/vers-${vmId.slice(0, 12)}.pem`;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, info.ssh_private_key, { mode: 0o600 });
    return path;
  }

  function sshExec(keyPath: string, vmId: string, command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile("ssh", [
        "-i", keyPath,
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "LogLevel=ERROR",
        "-o", `ProxyCommand=openssl s_client -connect %h:443 -servername %h -quiet 2>/dev/null`,
        `root@${vmId}.vm.vers.sh`,
        command,
      ], (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      });
    });
  }

  pi.registerTool({
    name: "vm_exec",
    label: "Run on VM",
    description: "Execute a command on a Vers VM via SSH",
    parameters: Type.Object({
      vmId: Type.String({ description: "VM ID" }),
      command: Type.String({ description: "Command to run" }),
    }),
    async execute(_id, params) {
      const keyPath = await getKeyPath(params.vmId);
      const output = await sshExec(keyPath, params.vmId, params.command);
      return { content: [{ type: "text", text: output || "(no output)" }] };
    },
  });
```

Reload. Ask the agent to create a VM then run `uname -a` on it. You'll see the VM's Linux kernel info.

## Step 4: Override `bash` for Transparent Routing

This is the key pattern. Instead of making the LLM use a special `vm_exec` tool, override `bash` so the LLM's normal commands go to the VM automatically:

```typescript
  // Add inside myVersExtension:
  let activeVmId: string | undefined;

  pi.registerTool({
    name: "vm_use",
    label: "Use VM",
    description: "Route all bash commands to this VM",
    parameters: Type.Object({ vmId: Type.String({ description: "VM ID" }) }),
    async execute(_id, params) {
      activeVmId = params.vmId;
      return { content: [{ type: "text", text: `Now routing to VM ${params.vmId}` }] };
    },
  });

  pi.registerTool({
    name: "vm_local",
    label: "Use Local",
    description: "Stop routing to VM, run commands locally",
    parameters: Type.Object({}),
    async execute() {
      activeVmId = undefined;
      return { content: [{ type: "text", text: "Back to local" }] };
    },
  });

  pi.registerTool({
    name: "bash",
    label: "bash",
    description: "Execute a bash command. Routes to active VM if set, otherwise runs locally.",
    parameters: Type.Object({
      command: Type.String({ description: "Bash command to execute" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
    }),
    async execute(_id, params) {
      if (!activeVmId) {
        // Local execution
        return new Promise((resolve) => {
          execFile("bash", ["-c", params.command], (err, stdout, stderr) => {
            const output = (stdout || "") + (stderr || "");
            if (err) resolve({ content: [{ type: "text", text: `${output}\nExit code: ${err.code}` }] });
            else resolve({ content: [{ type: "text", text: output || "(no output)" }] });
          });
        });
      }
      // Remote execution
      const keyPath = await getKeyPath(activeVmId);
      const output = await sshExec(keyPath, activeVmId, params.command);
      return { content: [{ type: "text", text: output || "(no output)" }] };
    },
  });
```

Reload. Now the LLM can `vm_use` a VM, then every `bash` call runs remotely. `vm_local` switches back. The LLM doesn't need to think about SSH — it just calls `bash` as usual.

This is how the full Vers extension works. It overrides all four core tools (`bash`, `read`, `edit`, `write`) and routes them based on a single flag.

## Step 5: Add Status and Cleanup

Show the active VM in the footer and clean up on exit:

```typescript
  // Add inside myVersExtension:

  pi.on("session_start", async (_event, ctx) => {
    try {
      const vms = await versApi("GET", "/vms");
      ctx.ui.setStatus("vers", `vers: ${vms.length} VM(s)`);
    } catch {
      ctx.ui.setStatus("vers", "vers: offline");
    }
  });

  pi.on("session_shutdown", async () => {
    activeVmId = undefined;
  });
```

Reload. You should see "vers: N VM(s)" in the footer.

## The Full Extension

Here's everything assembled into one file (~80 lines of actual logic):

```typescript
// ~/.pi/agent/extensions/my-vers.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";

export default function myVersExtension(pi: ExtensionAPI) {
  const API_KEY = process.env.VERS_API_KEY || "";
  const BASE = "https://api.vers.sh/api/v1";
  let activeVmId: string | undefined;

  async function versApi(method: string, path: string, body?: unknown) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Vers API ${res.status}: ${await res.text()}`);
    return res.headers.get("content-type")?.includes("json") ? res.json() : undefined;
  }

  async function getKeyPath(vmId: string): Promise<string> {
    const info = await versApi("GET", `/vm/${vmId}/ssh_key`);
    const path = `/tmp/vers-${vmId.slice(0, 12)}.pem`;
    await writeFile(path, info.ssh_private_key, { mode: 0o600 });
    return path;
  }

  function sshExec(keyPath: string, vmId: string, command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile("ssh", [
        "-i", keyPath, "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
        "-o", "LogLevel=ERROR",
        "-o", `ProxyCommand=openssl s_client -connect %h:443 -servername %h -quiet 2>/dev/null`,
        `root@${vmId}.vm.vers.sh`, command,
      ], (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      });
    });
  }

  pi.registerTool({
    name: "create_vm", label: "Create VM",
    description: "Create a new Vers VM",
    parameters: Type.Object({}),
    async execute() {
      const r = await versApi("POST", "/vm/new_root?wait_boot=true", {
        vm_config: { mem_size_mib: 4096, fs_size_mib: 8192 },
      });
      return { content: [{ type: "text", text: `VM created: ${r.vm_id}` }] };
    },
  });

  pi.registerTool({
    name: "vm_use", label: "Use VM",
    description: "Route bash commands to this VM",
    parameters: Type.Object({ vmId: Type.String({ description: "VM ID" }) }),
    async execute(_id, params, _s, _u, ctx) {
      activeVmId = params.vmId;
      ctx.ui.setStatus("vers", `vers: ${params.vmId.slice(0, 12)}`);
      return { content: [{ type: "text", text: `Routing to ${params.vmId}` }] };
    },
  });

  pi.registerTool({
    name: "vm_local", label: "Use Local",
    description: "Stop routing to VM",
    parameters: Type.Object({}),
    async execute(_id, _p, _s, _u, ctx) {
      activeVmId = undefined;
      ctx.ui.setStatus("vers", undefined);
      return { content: [{ type: "text", text: "Back to local" }] };
    },
  });

  pi.registerTool({
    name: "bash", label: "bash",
    description: "Execute bash. Routes to active VM if set.",
    parameters: Type.Object({
      command: Type.String({ description: "Command" }),
      timeout: Type.Optional(Type.Number()),
    }),
    async execute(_id, params) {
      if (!activeVmId) {
        return new Promise((resolve) => {
          execFile("bash", ["-c", params.command], (err, stdout, stderr) => {
            const out = (stdout || "") + (stderr || "");
            if (err) resolve({ content: [{ type: "text", text: `${out}\nExit: ${err.code}` }] });
            else resolve({ content: [{ type: "text", text: out || "(no output)" }] });
          });
        });
      }
      const key = await getKeyPath(activeVmId);
      const out = await sshExec(key, activeVmId, params.command);
      return { content: [{ type: "text", text: out || "(no output)" }] };
    },
  });

  pi.on("session_start", async (_ev, ctx) => {
    try {
      const vms = await versApi("GET", "/vms");
      ctx.ui.setStatus("vers", `vers: ${vms.length} VM(s)`);
    } catch { ctx.ui.setStatus("vers", "vers: offline"); }
  });
}
```

Copy this file, set `VERS_API_KEY`, run pi. You have VM management.

## What You Built

- **`create_vm`**: creates a Vers VM via API
- **`vm_use` / `vm_local`**: sets or clears the active VM
- **`bash` override**: routes commands to the active VM over SSH, falls back to local
- **Status bar**: shows active VM or VM count

The core pattern: check a state variable, route to remote or local. The LLM doesn't know which path runs. Extend this to `read`, `edit`, and `write` by registering tools with those names and using SSH for file operations.

## Next Steps

- Override `read`, `edit`, `write` the same way (the [full extension](https://github.com/hdresearch/pi-v/blob/main/extensions/vers-vm.ts) does this)
- Add `vers_vm_commit` / `vers_vm_restore` for snapshots
- Add `vers_vm_branch` for cloning VMs
- Add `vers_vm_copy` for SCP file transfers
