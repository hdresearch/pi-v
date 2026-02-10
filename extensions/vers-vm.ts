/**
 * Vers VM Extension (pi adapter)
 *
 * Thin wrapper around the core VersClient. When a VM is active, the built-in
 * tools (read, bash, edit, write) are routed through SSH to the VM.
 *
 * Tools provided:
 *   vers_vms, vers_vm_create, vers_vm_delete, vers_vm_branch,
 *   vers_vm_commit, vers_vm_restore, vers_vm_state,
 *   vers_vm_use, vers_vm_local
 *
 * Overrides (when a VM is active):
 *   read, bash, edit, write — routed through SSH to the active VM
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { access, readFile, writeFile as fsWriteFile, mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { constants } from "node:fs";
import { VersClient, shellEscape, type VmConfig } from "../src/core/vers-client.js";

export default function versVmExtension(pi: ExtensionAPI) {
	pi.registerFlag("vers-api-key", {
		description: "Vers API key (default: VERS_API_KEY env var)",
		type: "string",
		default: "",
	});

	pi.registerFlag("vers-base-url", {
		description: "Vers API base URL (default: https://api.vers.sh)",
		type: "string",
		default: "",
	});

	pi.registerFlag("vers-ssh-timeout", {
		description: "Default timeout in seconds for remote SSH commands (default: 120). Set to 0 for no timeout.",
		type: "number",
		default: 120,
	});

	let client: VersClient | undefined;
	let activeVmId: string | undefined;

	function getClient(): VersClient {
		if (!client) {
			const apiKey = (pi.getFlag("vers-api-key") as string) || undefined;
			const baseURL = (pi.getFlag("vers-base-url") as string) || undefined;
			client = new VersClient({ apiKey, baseURL });
		}
		return client;
	}

	/** Expose getClient for swarm extension */
	(pi as any).__versGetClient = getClient;

	function updateStatus(ctx: { ui: { setStatus: (key: string, text: string | undefined) => void } }) {
		if (activeVmId) {
			ctx.ui.setStatus("vers", `vers: ${activeVmId.slice(0, 12)}`);
		} else {
			ctx.ui.setStatus("vers", undefined);
		}
	}

	// =========================================================================
	// VM management tools
	// =========================================================================

	pi.registerTool({
		name: "vers_vms",
		label: "Vers VMs",
		description: "List all Vers VMs. Returns VM IDs, states, and creation times.",
		parameters: Type.Object({}),
		async execute() {
			const vms = await getClient().list();
			const active = activeVmId ? ` (active: ${activeVmId.slice(0, 12)})` : "";
			return {
				content: [{ type: "text", text: `${vms.length} VM(s)${active}\n\n${JSON.stringify(vms, null, 2)}` }],
				details: { vms },
			};
		},
	});

	pi.registerTool({
		name: "vers_vm_create",
		label: "Create Vers VM",
		description: "Create a new root Firecracker VM on the Vers platform. Optionally configure CPU, memory, and disk size.",
		parameters: Type.Object({
			vcpu_count: Type.Optional(Type.Number({ description: "Number of vCPUs" })),
			mem_size_mib: Type.Optional(Type.Number({ description: "RAM in MiB" })),
			fs_size_mib: Type.Optional(Type.Number({ description: "Disk size in MiB" })),
			wait_boot: Type.Optional(Type.Boolean({ description: "Wait for VM to finish booting (default: false)" })),
		}),
		async execute(_id, params) {
			const { vcpu_count, mem_size_mib, fs_size_mib, wait_boot } = params as any;
			const cfg: VmConfig = {};
			if (vcpu_count !== undefined) cfg.vcpu_count = vcpu_count;
			if (mem_size_mib !== undefined) cfg.mem_size_mib = mem_size_mib;
			if (fs_size_mib !== undefined) cfg.fs_size_mib = fs_size_mib;
			const result = await getClient().createRoot(cfg, wait_boot);
			return { content: [{ type: "text", text: `VM created: ${result.vm_id}` }], details: result };
		},
	});

	pi.registerTool({
		name: "vers_vm_delete",
		label: "Delete Vers VM",
		description: "Delete a Vers VM by ID.",
		parameters: Type.Object({ vmId: Type.String({ description: "VM ID to delete" }) }),
		async execute(_id, params) {
			const { vmId } = params as { vmId: string };
			if (activeVmId === vmId) activeVmId = undefined;
			const result = await getClient().delete(vmId);
			return { content: [{ type: "text", text: `VM ${result.vm_id} deleted.` }], details: result };
		},
	});

	pi.registerTool({
		name: "vers_vm_branch",
		label: "Branch Vers VM",
		description: "Clone a VM by branching it. Creates a new VM with the same state. Like git branching for VMs.",
		parameters: Type.Object({ vmId: Type.String({ description: "VM ID to branch from" }) }),
		async execute(_id, params) {
			const { vmId } = params as { vmId: string };
			const result = await getClient().branch(vmId);
			return { content: [{ type: "text", text: `Branched VM ${vmId} -> ${result.vm_id}` }], details: result };
		},
	});

	pi.registerTool({
		name: "vers_vm_commit",
		label: "Commit Vers VM",
		description: "Snapshot a VM to a commit. The commit ID can be used later to restore or branch from this state.",
		parameters: Type.Object({
			vmId: Type.String({ description: "VM ID to commit" }),
			keep_paused: Type.Optional(Type.Boolean({ description: "Keep VM paused after commit (default: false)" })),
		}),
		async execute(_id, params) {
			const { vmId, keep_paused } = params as { vmId: string; keep_paused?: boolean };
			const result = await getClient().commit(vmId, keep_paused);
			return { content: [{ type: "text", text: `VM ${vmId} committed: ${result.commit_id}` }], details: result };
		},
	});

	pi.registerTool({
		name: "vers_vm_restore",
		label: "Restore Vers VM",
		description: "Restore a new VM from a previously created commit.",
		parameters: Type.Object({ commitId: Type.String({ description: "Commit ID to restore from" }) }),
		async execute(_id, params) {
			const { commitId } = params as { commitId: string };
			const result = await getClient().restoreFromCommit(commitId);
			return { content: [{ type: "text", text: `Restored from commit ${commitId} -> VM ${result.vm_id}` }], details: result };
		},
	});

	pi.registerTool({
		name: "vers_vm_state",
		label: "Update Vers VM State",
		description: "Pause or resume a Vers VM.",
		parameters: Type.Object({
			vmId: Type.String({ description: "VM ID to update" }),
			state: Type.Union([Type.Literal("Paused"), Type.Literal("Running")], { description: "Target state" }),
		}),
		async execute(_id, params) {
			const { vmId, state } = params as { vmId: string; state: "Paused" | "Running" };
			await getClient().updateState(vmId, state);
			return { content: [{ type: "text", text: `VM ${vmId} state set to ${state}.` }], details: { vmId, state } };
		},
	});

	// =========================================================================
	// Active VM context tools
	// =========================================================================

	pi.registerTool({
		name: "vers_vm_use",
		label: "Use Vers VM",
		description: "Set the active VM. After calling this, read/bash/edit/write tools execute on the VM via SSH instead of locally.",
		parameters: Type.Object({
			vmId: Type.String({ description: "VM ID to use as the active execution target" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { vmId } = params as { vmId: string };
			const result = await getClient().exec(vmId, "echo ok");
			if (result.stdout.trim() !== "ok") {
				throw new Error(`Cannot reach VM ${vmId}: ${result.stderr}`);
			}
			activeVmId = vmId;
			if (ctx) updateStatus(ctx);
			return {
				content: [{ type: "text", text: `Active VM set to ${vmId}. All read/bash/edit/write tools now execute on this VM.` }],
				details: { vmId },
			};
		},
	});

	pi.registerTool({
		name: "vers_vm_local",
		label: "Switch to Local",
		description: "Clear the active VM. read/bash/edit/write tools will execute locally again.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const prev = activeVmId;
			activeVmId = undefined;
			if (ctx) updateStatus(ctx);
			return {
				content: [{ type: "text", text: prev ? `Switched from VM ${prev} back to local execution.` : "Already in local mode." }],
				details: {},
			};
		},
	});

	// =========================================================================
	// Override built-in tools: route to VM when active, local when not
	// =========================================================================

	// --- bash ---
	pi.registerTool({
		name: "bash",
		label: "bash",
		description: "Execute a bash command. When a Vers VM is active, executes on the VM via SSH (default timeout: 120s, configurable via --vers-ssh-timeout). Otherwise executes locally.",
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(Type.Number({ description: "Timeout in seconds. Remote default: 120s (--vers-ssh-timeout). Pass 0 for no timeout." })),
		}),
		async execute(_id, params, signal, onUpdate) {
			const { command, timeout } = params as { command: string; timeout?: number };

			if (!activeVmId) {
				return localBash(command, timeout, signal, onUpdate);
			}

			const defaultTimeout = pi.getFlag("vers-ssh-timeout") as number;
			const effectiveTimeout = timeout !== undefined ? timeout : (defaultTimeout > 0 ? defaultTimeout : undefined);

			const chunks: Buffer[] = [];

			const handleData = (data: Buffer) => {
				chunks.push(data);
				if (onUpdate) {
					const text = Buffer.concat(chunks).toString("utf-8");
					const truncated = text.length > 50000 ? text.slice(-50000) : text;
					onUpdate({ content: [{ type: "text", text: truncated }], details: {} });
				}
			};

			try {
				const result = await getClient().execStreaming(activeVmId, command, {
					onData: handleData,
					signal,
					timeout: effectiveTimeout,
				});

				const output = Buffer.concat(chunks).toString("utf-8") || "(no output)";
				const exitCode = result.exitCode ?? 0;

				if (exitCode !== 0) {
					throw new Error(`${output}\n\nCommand exited with code ${exitCode}`);
				}
				return { content: [{ type: "text", text: output }], details: {} };
			} catch (err: any) {
				if (err.message === "aborted") throw new Error("Command aborted");
				if (err.message.startsWith("timeout:")) {
					const partialOutput = Buffer.concat(chunks).toString("utf-8");
					const hint = effectiveTimeout === defaultTimeout
						? ` (default --vers-ssh-timeout=${defaultTimeout}s). Pass a larger timeout parameter or use 0 to disable.`
						: `s.`;
					throw new Error(
						`SSH command timed out after ${effectiveTimeout}${hint}` +
						(partialOutput ? `\n\nPartial output:\n${partialOutput.slice(-5000)}` : "")
					);
				}
				throw err;
			}
		},
	});

	// --- read ---
	pi.registerTool({
		name: "read",
		label: "read",
		description: "Read the contents of a file. When a Vers VM is active, reads from the VM via SSH. Supports offset/limit for large files.",
		parameters: Type.Object({
			path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
			offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
		}),
		async execute(_id, params) {
			const { path, offset, limit } = params as { path: string; offset?: number; limit?: number };

			if (!activeVmId) {
				return localRead(path, offset, limit);
			}

			let cmd: string;
			if (offset && limit) {
				cmd = `sed -n '${offset},${offset + limit - 1}p' ${shellEscape(path)}`;
			} else if (offset) {
				cmd = `tail -n +${offset} ${shellEscape(path)}`;
			} else if (limit) {
				cmd = `head -n ${limit} ${shellEscape(path)}`;
			} else {
				cmd = `cat ${shellEscape(path)}`;
			}

			const wcResult = await getClient().exec(activeVmId, `wc -l < ${shellEscape(path)}`);
			const totalLines = parseInt(wcResult.stdout.trim()) || 0;

			const result = await getClient().exec(activeVmId, cmd);
			if (result.exitCode !== 0) {
				throw new Error(result.stderr || `Failed to read ${path}`);
			}

			let text = result.stdout;
			const outputLines = text.split("\n").length;

			if (text.length > 50000) {
				text = text.slice(0, 50000);
				text += `\n\n[Output truncated at 50KB. Use offset/limit for large files.]`;
			}

			const startLine = offset || 1;
			const endLine = startLine + outputLines - 1;
			if (endLine < totalLines) {
				text += `\n\n[Showing lines ${startLine}-${endLine} of ${totalLines}. Use offset=${endLine + 1} to continue.]`;
			}

			return { content: [{ type: "text", text }], details: {} };
		},
	});

	// --- edit ---
	pi.registerTool({
		name: "edit",
		label: "edit",
		description: "Edit a file by replacing exact text. When a Vers VM is active, edits the file on the VM via SSH. The oldText must match exactly.",
		parameters: Type.Object({
			path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
			oldText: Type.String({ description: "Exact text to find and replace (must match exactly)" }),
			newText: Type.String({ description: "New text to replace the old text with" }),
		}),
		async execute(_id, params) {
			const { path, oldText, newText } = params as { path: string; oldText: string; newText: string };

			if (!activeVmId) {
				return localEdit(path, oldText, newText);
			}

			const readResult = await getClient().exec(activeVmId, `cat ${shellEscape(path)}`);
			if (readResult.exitCode !== 0) {
				throw new Error(readResult.stderr || `File not found: ${path}`);
			}

			const content = readResult.stdout;
			const index = content.indexOf(oldText);
			if (index === -1) {
				throw new Error(`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`);
			}
			if (content.indexOf(oldText, index + 1) !== -1) {
				throw new Error(`Found multiple occurrences of the text in ${path}. Please provide more context to make it unique.`);
			}

			const newContent = content.substring(0, index) + newText + content.substring(index + oldText.length);
			const marker = `VERS_EOF_${Date.now()}`;
			const writeCmd = `cat > ${shellEscape(path)} << '${marker}'\n${newContent}\n${marker}`;
			const writeResult = await getClient().exec(activeVmId, writeCmd);
			if (writeResult.exitCode !== 0) {
				throw new Error(writeResult.stderr || `Failed to write ${path}`);
			}

			return { content: [{ type: "text", text: `Successfully replaced text in ${path}.` }], details: {} };
		},
	});

	// --- write ---
	pi.registerTool({
		name: "write",
		label: "write",
		description: "Write content to a file. When a Vers VM is active, writes to the VM via SSH. Creates parent directories automatically.",
		parameters: Type.Object({
			path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
			content: Type.String({ description: "Content to write to the file" }),
		}),
		async execute(_id, params) {
			const { path, content } = params as { path: string; content: string };

			if (!activeVmId) {
				return localWrite(path, content);
			}

			const dir = path.replace(/\/[^/]*$/, "");
			if (dir && dir !== path) {
				await getClient().exec(activeVmId, `mkdir -p ${shellEscape(dir)}`);
			}

			const marker = `VERS_EOF_${Date.now()}`;
			const writeCmd = `cat > ${shellEscape(path)} << '${marker}'\n${content}\n${marker}`;
			const result = await getClient().exec(activeVmId, writeCmd);
			if (result.exitCode !== 0) {
				throw new Error(result.stderr || `Failed to write ${path}`);
			}

			return { content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }], details: undefined };
		},
	});

	// =========================================================================
	// Health check / status on startup
	// =========================================================================

	pi.on("session_start", async (_event, ctx) => {
		try {
			const vms = await getClient().list();
			ctx.ui.setStatus("vers", `vers: ${vms.length} VM(s)`);
		} catch (err) {
			ctx.ui.setStatus("vers", "vers: offline");
			ctx.ui.notify(
				`Vers connection failed: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		}
	});

	// =========================================================================
	// /vers command — VM dashboard
	// =========================================================================

	pi.registerCommand("vers", {
		description: "Vers VM dashboard — view and manage VMs",
		handler: async (_args, ctx) => {
			try {
				const vms = await getClient().list();
				if (vms.length === 0) {
					ctx.ui.notify("No VMs running.", "info");
					return;
				}

				const options = vms.map((v) => {
					const active = v.vm_id === activeVmId ? " ★" : "";
					return `${v.vm_id.slice(0, 12)} [${v.state}]${active} (${v.created_at})`;
				});

				const selected = await ctx.ui.select(`Vers VMs (${vms.length})`, options);
				if (selected === undefined) return;

				const selectedVm = vms[options.indexOf(selected)];
				if (!selectedVm) return;

				const actions = [
					"use — Set as active VM",
					"exec — Run shell command",
					"branch — Clone this VM",
					"commit — Snapshot",
					"pause — Pause",
					"resume — Resume",
					"delete — Delete",
					"cancel",
				];

				const action = await ctx.ui.select(`VM ${selectedVm.vm_id.slice(0, 12)}`, actions);
				if (!action || action === "cancel") return;

				if (action.startsWith("use")) {
					activeVmId = selectedVm.vm_id;
					updateStatus(ctx);
					ctx.ui.notify(`Active VM: ${selectedVm.vm_id.slice(0, 12)}. Tools now route to this VM.`, "info");
				} else if (action.startsWith("exec")) {
					const command = await ctx.ui.input("Command to execute");
					if (command) {
						const result = await getClient().exec(selectedVm.vm_id, command);
						ctx.ui.notify(`Exit ${result.exitCode}: ${result.stdout.slice(0, 500)}`, result.exitCode === 0 ? "info" : "warning");
					}
				} else if (action.startsWith("branch")) {
					const r = await getClient().branch(selectedVm.vm_id);
					ctx.ui.notify(`Branched -> ${r.vm_id}`, "info");
				} else if (action.startsWith("commit")) {
					const r = await getClient().commit(selectedVm.vm_id);
					ctx.ui.notify(`Committed -> ${r.commit_id}`, "info");
				} else if (action.startsWith("pause")) {
					await getClient().updateState(selectedVm.vm_id, "Paused");
					ctx.ui.notify("Paused.", "info");
				} else if (action.startsWith("resume")) {
					await getClient().updateState(selectedVm.vm_id, "Running");
					ctx.ui.notify("Resumed.", "info");
				} else if (action.startsWith("delete")) {
					const ok = await ctx.ui.confirm("Delete VM", `Delete ${selectedVm.vm_id}?`);
					if (ok) {
						if (activeVmId === selectedVm.vm_id) activeVmId = undefined;
						await getClient().delete(selectedVm.vm_id);
						updateStatus(ctx);
						ctx.ui.notify("Deleted.", "info");
					}
				}
			} catch (err) {
				ctx.ui.notify(`Vers error: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}

// =============================================================================
// Local tool fallbacks (when no VM is active)
// =============================================================================

function localBash(
	command: string,
	timeout: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: any,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: any }> {
	const chunks: Buffer[] = [];

	return new Promise((resolve, reject) => {
		const child = spawn("bash", ["-c", command], {
			cwd: process.cwd(),
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});

		let timedOut = false;
		let timeoutHandle: NodeJS.Timeout | undefined;
		if (timeout && timeout > 0) {
			timeoutHandle = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeout * 1000);
		}

		const handleData = (data: Buffer) => {
			chunks.push(data);
			if (onUpdate) {
				const text = Buffer.concat(chunks).toString("utf-8");
				const truncated = text.length > 50000 ? text.slice(-50000) : text;
				onUpdate({ content: [{ type: "text", text: truncated }], details: {} });
			}
		};

		if (child.stdout) child.stdout.on("data", handleData);
		if (child.stderr) child.stderr.on("data", handleData);

		const onAbort = () => child.kill("SIGTERM");
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}

		child.on("error", (err) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			reject(err);
		});

		child.on("close", (code) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (signal) signal.removeEventListener("abort", onAbort);
			if (signal?.aborted) { reject(new Error("Command aborted")); return; }
			if (timedOut) { reject(new Error(`Command timed out after ${timeout} seconds`)); return; }

			const output = Buffer.concat(chunks).toString("utf-8") || "(no output)";
			if (code !== 0 && code !== null) {
				reject(new Error(`${output}\n\nCommand exited with code ${code}`));
			} else {
				resolve({ content: [{ type: "text", text: output }], details: {} });
			}
		});
	});
}

async function localRead(
	path: string,
	offset?: number,
	limit?: number,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: any }> {
	const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
	await access(abs, constants.R_OK);
	const buffer = await readFile(abs);
	const text = buffer.toString("utf-8");
	const lines = text.split("\n");
	const totalLines = lines.length;

	const start = offset ? Math.max(0, offset - 1) : 0;
	if (start >= lines.length) throw new Error(`Offset ${offset} is beyond end of file (${totalLines} lines)`);

	let selected: string[];
	if (limit !== undefined) {
		selected = lines.slice(start, start + limit);
	} else {
		selected = lines.slice(start);
	}

	let output = selected.join("\n");
	if (output.length > 50000) {
		output = output.slice(0, 50000) + "\n\n[Truncated at 50KB. Use offset/limit.]";
	}

	const endLine = start + selected.length;
	if (endLine < totalLines) {
		output += `\n\n[Showing lines ${start + 1}-${endLine} of ${totalLines}. Use offset=${endLine + 1} to continue.]`;
	}

	return { content: [{ type: "text", text: output }], details: {} };
}

async function localEdit(
	path: string,
	oldText: string,
	newText: string,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: any }> {
	const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
	await access(abs, constants.R_OK | constants.W_OK);
	const content = (await readFile(abs)).toString("utf-8");

	const index = content.indexOf(oldText);
	if (index === -1) throw new Error(`Could not find the exact text in ${path}.`);
	if (content.indexOf(oldText, index + 1) !== -1) throw new Error(`Found multiple occurrences in ${path}. Provide more context.`);

	const newContent = content.substring(0, index) + newText + content.substring(index + oldText.length);
	await fsWriteFile(abs, newContent, "utf-8");

	return { content: [{ type: "text", text: `Successfully replaced text in ${path}.` }], details: {} };
}

async function localWrite(
	path: string,
	content: string,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: any }> {
	const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
	const dir = abs.replace(/\/[^/]*$/, "");
	await mkdir(dir, { recursive: true });
	await fsWriteFile(abs, content, "utf-8");
	return { content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }], details: undefined };
}
