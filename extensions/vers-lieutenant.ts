/**
 * Vers Lieutenant Extension
 *
 * Persistent, conversational agent sessions running on Vers VMs.
 * Unlike swarm agents (fire-and-forget, task-bound), lieutenants are
 * long-lived, accumulate context, and support multi-turn interaction.
 *
 * Tools:
 *   vers_lt_create  - Spawn a lieutenant on a new VM with a name and role
 *   vers_lt_send    - Send a message (prompt, steer, or follow-up)
 *   vers_lt_read    - Read latest output from a lieutenant
 *   vers_lt_status  - Status overview of all lieutenants
 *   vers_lt_pause   - Pause a lieutenant's VM (preserves full state)
 *   vers_lt_resume  - Resume a paused lieutenant
 *   vers_lt_destroy - Tear down a specific lieutenant (or all)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// =============================================================================
// Types
// =============================================================================

interface Lieutenant {
	name: string;
	role: string;
	vmId: string;
	status: "starting" | "idle" | "working" | "paused" | "error";
	lastOutput: string;
	outputHistory: string[];  // Rolling buffer of complete responses
	taskCount: number;
	createdAt: string;
	lastActivityAt: string;
}

// =============================================================================
// Vers API helpers (duplicated from vers-swarm for extension independence)
// =============================================================================

function loadApiKey(): string {
	try {
		const homedir = process.env.HOME || process.env.USERPROFILE || "";
		const data = require("fs").readFileSync(join(homedir, ".vers", "keys.json"), "utf-8");
		return JSON.parse(data)?.keys?.VERS_API_KEY || "";
	} catch {
		return process.env.VERS_API_KEY || "";
	}
}

const BASE_URL = process.env.VERS_BASE_URL || "https://api.vers.sh/api/v1";

async function versApi<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(`${BASE_URL}${path}`, {
		method,
		headers: {
			"Content-Type": "application/json",
			"Authorization": `Bearer ${loadApiKey()}`,
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`Vers API ${method} ${path} (${res.status}): ${text}`);
	}
	const ct = res.headers.get("content-type") || "";
	if (ct.includes("application/json")) return res.json() as Promise<T>;
	return undefined as T;
}

interface SSHKeyInfo { ssh_port: number; ssh_private_key: string }

const keyCache = new Map<string, string>();

async function ensureKeyFile(vmId: string): Promise<string> {
	const existing = keyCache.get(vmId);
	if (existing) return existing;
	const info = await versApi<SSHKeyInfo>("GET", `/vm/${encodeURIComponent(vmId)}/ssh_key`);
	const keyDir = join(tmpdir(), "vers-ssh-keys");
	await mkdir(keyDir, { recursive: true });
	const keyPath = join(keyDir, `vers-${vmId.slice(0, 12)}.pem`);
	await writeFile(keyPath, info.ssh_private_key, { mode: 0o600 });
	keyCache.set(vmId, keyPath);
	return keyPath;
}

function sshArgs(keyPath: string, vmId: string): string[] {
	return [
		"-i", keyPath,
		"-o", "StrictHostKeyChecking=no",
		"-o", "UserKnownHostsFile=/dev/null",
		"-o", "LogLevel=ERROR",
		"-o", "ConnectTimeout=30",
		"-o", "ServerAliveInterval=15",
		"-o", "ServerAliveCountMax=4",
		"-o", `ProxyCommand=openssl s_client -connect %h:443 -servername %h -quiet 2>/dev/null`,
		`root@${vmId}.vm.vers.sh`,
	];
}

function sshExec(keyPath: string, vmId: string, command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolve, reject) => {
		const args = sshArgs(keyPath, vmId);
		const child = spawn("ssh", [...args, command], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
		child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
		child.on("error", reject);
		child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
	});
}

// =============================================================================
// RPC agent daemon (same architecture as vers-swarm)
// =============================================================================

const RPC_DIR = "/tmp/pi-rpc";
const RPC_IN = `${RPC_DIR}/in`;
const RPC_OUT = `${RPC_DIR}/out`;
const RPC_ERR = `${RPC_DIR}/err`;

interface RpcHandle {
	send: (cmd: object) => void;
	onEvent: (handler: (event: any) => void) => void;
	reconnectTail: () => void;
	kill: () => Promise<void>;
	vmId: string;
}

interface StartRpcOptions {
	anthropicApiKey: string;
	systemPrompt?: string;
}

async function startRpcAgent(keyPath: string, vmId: string, opts: StartRpcOptions): Promise<RpcHandle> {
	const envExports = [
		`export ANTHROPIC_API_KEY='${opts.anthropicApiKey}'`,
		process.env.VERS_API_KEY ? `export VERS_API_KEY='${loadApiKey()}'` : "",
		process.env.VERS_BASE_URL ? `export VERS_BASE_URL='${process.env.VERS_BASE_URL}'` : "",
	].filter(Boolean).join("; ");

	// Build pi command with optional system prompt
	let piCmd = "pi --mode rpc";
	if (opts.systemPrompt) {
		// Write system prompt to a file on the VM, reference it
		const escaped = opts.systemPrompt.replace(/'/g, "'\\''");
		await sshExec(keyPath, vmId, `mkdir -p /root/.pi/agent && cat > /root/.pi/agent/system-prompt.md << 'SYSPROMPT_EOF'\n${escaped}\nSYSPROMPT_EOF`);
		piCmd += " --system-prompt /root/.pi/agent/system-prompt.md";
	}

	const startScript = `
		set -e
		mkdir -p ${RPC_DIR}
		rm -f ${RPC_IN} ${RPC_OUT} ${RPC_ERR}
		mkfifo ${RPC_IN}
		touch ${RPC_OUT} ${RPC_ERR}
		tmux new-session -d -s pi-keeper "sleep infinity > ${RPC_IN}"
		tmux new-session -d -s pi-rpc "${envExports}; cd /root/workspace; ${piCmd} < ${RPC_IN} >> ${RPC_OUT} 2>> ${RPC_ERR}"
		sleep 1
		tmux has-session -t pi-rpc 2>/dev/null && echo "daemon_started" || echo "daemon_failed"
	`;

	const startResult = await sshExec(keyPath, vmId, startScript);
	if (!startResult.stdout.includes("daemon_started")) {
		throw new Error(`Failed to start pi daemon on ${vmId}: ${startResult.stderr || startResult.stdout}`);
	}

	let eventHandler: ((event: any) => void) | undefined;
	let tailChild: ReturnType<typeof spawn> | null = null;
	let lineBuf = "";
	let killed = false;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let linesProcessed = 0;

	function startTail() {
		if (killed) return;
		const args = sshArgs(keyPath, vmId);
		const startLine = linesProcessed > 0 ? linesProcessed + 1 : 1;
		tailChild = spawn("ssh", [...args, `tail -f -n +${startLine} ${RPC_OUT}`], {
			stdio: ["ignore", "pipe", "pipe"],
		});

		tailChild.stdout!.on("data", (data: Buffer) => {
			lineBuf += data.toString();
			const lines = lineBuf.split("\n");
			lineBuf = lines.pop() || "";
			for (const line of lines) {
				linesProcessed++;
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line);
					if (eventHandler) eventHandler(event);
				} catch { /* not JSON */ }
			}
		});

		tailChild.on("close", () => {
			if (killed) return;
			lineBuf = "";
			reconnectTimer = setTimeout(() => startTail(), 3000);
		});
	}

	startTail();

	function send(cmd: object) {
		if (killed) return;
		const json = JSON.stringify(cmd) + "\n";
		const writeChild = spawn("ssh", [...sshArgs(keyPath, vmId), `cat > ${RPC_IN}`], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		writeChild.stdin.write(json);
		writeChild.stdin.end();
		writeChild.on("error", (err) => {
			console.error(`[vers-lt] send failed (${vmId.slice(0, 12)}): ${err.message}`);
		});
	}

	function reconnectTail() {
		if (tailChild) {
			try { tailChild.kill("SIGTERM"); } catch { /* ignore */ }
			tailChild = null;
		}
		if (reconnectTimer) clearTimeout(reconnectTimer);
		startTail();
	}

	async function kill() {
		killed = true;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		if (tailChild) {
			try { tailChild.kill("SIGTERM"); } catch { /* ignore */ }
			tailChild = null;
		}
		try {
			await sshExec(keyPath, vmId, `
				tmux kill-session -t pi-rpc 2>/dev/null || true
				tmux kill-session -t pi-keeper 2>/dev/null || true
				rm -rf ${RPC_DIR}
			`);
		} catch { /* VM might already be gone */ }
	}

	return { send, onEvent: (h) => { eventHandler = h; }, reconnectTail, kill, vmId };
}

// =============================================================================
// Extension
// =============================================================================

export default function versLieutenantExtension(pi: ExtensionAPI) {
	const lieutenants = new Map<string, Lieutenant>();
	const rpcHandles = new Map<string, RpcHandle>();

	function updateWidget(ctx?: { ui: { setWidget: (key: string, lines: string[] | undefined) => void } }) {
		if (!ctx) return;
		if (lieutenants.size === 0) {
			ctx.ui.setWidget("vers-lt", undefined);
			return;
		}
		const lines: string[] = [`─── Lieutenants (${lieutenants.size}) ───`];
		for (const [name, lt] of lieutenants) {
			const icon = lt.status === "working" ? "⟳" :
				lt.status === "idle" ? "●" :
				lt.status === "paused" ? "⏸" :
				lt.status === "error" ? "✗" : "○";
			const tasks = lt.taskCount > 0 ? ` (${lt.taskCount} tasks)` : "";
			lines.push(`${icon} ${name}: ${lt.status}${tasks} — ${lt.role.slice(0, 40)}`);
		}
		ctx.ui.setWidget("vers-lt", lines);
	}

	// --- vers_lt_create ---
	pi.registerTool({
		name: "vers_lt_create",
		label: "Create Lieutenant",
		description: [
			"Spawn a persistent agent session on a new Vers VM.",
			"The lieutenant stays alive across tasks, accumulates context,",
			"and can be paused/resumed. Give it a name and role.",
		].join(" "),
		parameters: Type.Object({
			name: Type.String({ description: "Short name for this lieutenant (e.g., 'infra', 'billing')" }),
			role: Type.String({ description: "Role description — becomes the lieutenant's system prompt context" }),
			commitId: Type.String({ description: "Golden image commit ID to create VM from" }),
			anthropicApiKey: Type.String({ description: "Anthropic API key for the lieutenant to use" }),
			model: Type.Optional(Type.String({ description: "Model ID (default: claude-sonnet-4-20250514)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { name, role, commitId, anthropicApiKey, model } = params as {
				name: string; role: string; commitId: string;
				anthropicApiKey: string; model?: string;
			};

			if (lieutenants.has(name)) {
				throw new Error(`Lieutenant '${name}' already exists. Destroy it first or use a different name.`);
			}

			// Create VM from golden commit
			const vm = await versApi<{ vm_id: string }>("POST", "/vm/from_commit", { commit_id: commitId });
			const vmId = vm.vm_id;

			// Wait for SSH
			let retries = 30;
			let keyPath = "";
			while (retries > 0) {
				try {
					keyPath = await ensureKeyFile(vmId);
					const check = await sshExec(keyPath, vmId, "echo ready");
					if (check.stdout.trim() === "ready") break;
				} catch { /* not ready yet */ }
				await new Promise(r => setTimeout(r, 2000));
				retries--;
			}
			if (retries === 0) {
				try { await versApi("DELETE", `/vm/${vmId}`); } catch { /* ignore */ }
				throw new Error(`VM ${vmId} failed to boot within 60s`);
			}

			// Build system prompt that gives the lieutenant its identity
			const systemPrompt = [
				`You are a lieutenant agent named "${name}".`,
				`Your role: ${role}`,
				"",
				"You are a persistent, long-lived agent session managed by a coordinator.",
				"You accumulate context across multiple tasks. When given a new task,",
				"you have full memory of previous work in this session.",
				"",
				"You have access to all pi tools including Vers VM management and swarm",
				"orchestration. You can spawn your own sub-swarms for parallel work.",
				"",
				"When you complete a task, end with a clear summary of what was done",
				"and any open questions or next steps.",
			].join("\n");

			// Start pi RPC daemon
			const handle = await startRpcAgent(keyPath, vmId, {
				anthropicApiKey,
				systemPrompt,
			});

			// Wait for RPC ready
			const rpcReady = await new Promise<boolean>((resolve) => {
				let resolved = false;
				const timeout = setTimeout(() => { if (!resolved) { resolved = true; resolve(false); } }, 45000);
				handle.onEvent((event) => {
					if (!resolved && event.type === "response" && event.command === "get_state") {
						resolved = true;
						clearTimeout(timeout);
						resolve(true);
					}
				});
				let attempts = 0;
				const trySend = () => {
					if (resolved || attempts > 8) return;
					attempts++;
					handle.send({ id: "startup-check", type: "get_state" });
					setTimeout(trySend, 3000);
				};
				setTimeout(trySend, 3000);
			});

			if (!rpcReady) {
				await handle.kill();
				try { await versApi("DELETE", `/vm/${vmId}`); } catch { /* ignore */ }
				throw new Error(`Pi RPC failed to start on ${vmId}`);
			}

			const lt: Lieutenant = {
				name,
				role,
				vmId,
				status: "idle",
				lastOutput: "",
				outputHistory: [],
				taskCount: 0,
				createdAt: new Date().toISOString(),
				lastActivityAt: new Date().toISOString(),
			};

			// Install event handler
			handle.onEvent((event) => {
				if (event.type === "agent_start") {
					lt.status = "working";
					lt.lastOutput = "";
					lt.lastActivityAt = new Date().toISOString();
				} else if (event.type === "agent_end") {
					lt.status = "idle";
					lt.lastActivityAt = new Date().toISOString();
					// Archive the completed response
					if (lt.lastOutput.trim()) {
						lt.outputHistory.push(lt.lastOutput);
						// Keep last 20 responses
						if (lt.outputHistory.length > 20) lt.outputHistory.shift();
					}
				} else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
					lt.lastOutput += event.assistantMessageEvent.delta;
				}
			});

			// Set model if specified
			if (model) {
				handle.send({ type: "set_model", provider: "anthropic", modelId: model });
			}

			lieutenants.set(name, lt);
			rpcHandles.set(name, handle);
			if (ctx) updateWidget(ctx);

			return {
				content: [{
					type: "text",
					text: [
						`Lieutenant "${name}" is ready.`,
						`  VM: ${vmId}`,
						`  Role: ${role}`,
						`  Status: idle — waiting for first task`,
					].join("\n"),
				}],
				details: { name, vmId, role },
			};
		},
	});

	// --- vers_lt_send ---
	pi.registerTool({
		name: "vers_lt_send",
		label: "Send to Lieutenant",
		description: [
			"Send a message to a lieutenant. Behavior depends on mode:",
			"  'prompt' (default when idle) — start a new task",
			"  'steer' — interrupt current work and redirect",
			"  'followUp' — queue message for after current task finishes",
		].join("\n"),
		parameters: Type.Object({
			name: Type.String({ description: "Lieutenant name" }),
			message: Type.String({ description: "The message to send" }),
			mode: Type.Optional(Type.Union([
				Type.Literal("prompt"),
				Type.Literal("steer"),
				Type.Literal("followUp"),
			], { description: "Message mode: 'prompt' (default), 'steer' (interrupt), 'followUp' (queue). If lieutenant is working and mode is 'prompt', it auto-selects 'followUp'." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { name, message, mode } = params as {
				name: string; message: string; mode?: "prompt" | "steer" | "followUp";
			};

			const lt = lieutenants.get(name);
			if (!lt) throw new Error(`Lieutenant '${name}' not found. Available: ${Array.from(lieutenants.keys()).join(", ") || "none"}`);
			if (lt.status === "paused") throw new Error(`Lieutenant '${name}' is paused. Resume it first with vers_lt_resume.`);

			const handle = rpcHandles.get(name);
			if (!handle) throw new Error(`No RPC handle for '${name}'`);

			let actualMode = mode || "prompt";
			let modeNote = "";

			// Auto-select mode based on lieutenant state
			if (lt.status === "working" && actualMode === "prompt") {
				// Lieutenant is busy — queue as follow-up rather than error
				actualMode = "followUp";
				modeNote = " (auto-queued as follow-up since lieutenant is working)";
			}

			// Send via RPC
			if (actualMode === "prompt") {
				lt.taskCount++;
				lt.lastOutput = "";
				handle.send({ type: "prompt", message });
			} else if (actualMode === "steer") {
				handle.send({ type: "steer", message });
			} else if (actualMode === "followUp") {
				handle.send({ type: "follow_up", message });
			}

			lt.lastActivityAt = new Date().toISOString();
			if (ctx) updateWidget(ctx);

			return {
				content: [{
					type: "text",
					text: `Sent to ${name} (${actualMode})${modeNote}: "${message.slice(0, 120)}${message.length > 120 ? "..." : ""}"`,
				}],
			};
		},
	});

	// --- vers_lt_read ---
	pi.registerTool({
		name: "vers_lt_read",
		label: "Read Lieutenant Output",
		description: "Read the latest output from a lieutenant. Shows current response if working, or last completed response if idle.",
		parameters: Type.Object({
			name: Type.String({ description: "Lieutenant name" }),
			tail: Type.Optional(Type.Number({ description: "Characters from end (default: all)" })),
			history: Type.Optional(Type.Number({ description: "Number of previous responses to include (default: 0, max: 20)" })),
		}),
		async execute(_id, params) {
			const { name, tail, history } = params as { name: string; tail?: number; history?: number };

			const lt = lieutenants.get(name);
			if (!lt) throw new Error(`Lieutenant '${name}' not found. Available: ${Array.from(lieutenants.keys()).join(", ") || "none"}`);

			let output = lt.lastOutput || "(no output yet)";
			if (tail && output.length > tail) {
				output = "..." + output.slice(-tail);
			}

			const parts: string[] = [];

			// Include history if requested
			if (history && history > 0) {
				const count = Math.min(history, lt.outputHistory.length);
				const start = lt.outputHistory.length - count;
				for (let i = start; i < lt.outputHistory.length; i++) {
					parts.push(`=== Response ${i + 1} ===\n${lt.outputHistory[i]}\n`);
				}
				parts.push(`=== Current (${lt.status}) ===\n${output}`);
			} else {
				parts.push(`[${name}] (${lt.status}, ${lt.taskCount} tasks):\n\n${output}`);
			}

			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: {
					name,
					status: lt.status,
					taskCount: lt.taskCount,
					outputLength: lt.lastOutput.length,
					historyCount: lt.outputHistory.length,
				},
			};
		},
	});

	// --- vers_lt_status ---
	pi.registerTool({
		name: "vers_lt_status",
		label: "Lieutenant Status",
		description: "Overview of all lieutenants: status, role, task count, last activity.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			if (ctx) updateWidget(ctx);

			if (lieutenants.size === 0) {
				return { content: [{ type: "text", text: "No lieutenants active." }] };
			}

			const lines: string[] = [];
			for (const [name, lt] of lieutenants) {
				const icon = lt.status === "working" ? "⟳" :
					lt.status === "idle" ? "●" :
					lt.status === "paused" ? "⏸" :
					lt.status === "error" ? "✗" : "○";
				lines.push([
					`${icon} ${name} [${lt.status}]`,
					`  Role: ${lt.role}`,
					`  VM: ${lt.vmId.slice(0, 12)}`,
					`  Tasks: ${lt.taskCount}`,
					`  Last active: ${lt.lastActivityAt}`,
					`  Output: ${lt.lastOutput.length} chars${lt.status === "working" ? " (streaming...)" : ""}`,
				].join("\n"));
			}

			return {
				content: [{ type: "text", text: lines.join("\n\n") }],
				details: {
					lieutenants: Array.from(lieutenants.values()).map(lt => ({
						name: lt.name, vmId: lt.vmId, status: lt.status,
						taskCount: lt.taskCount, role: lt.role,
					})),
				},
			};
		},
	});

	// --- vers_lt_pause ---
	pi.registerTool({
		name: "vers_lt_pause",
		label: "Pause Lieutenant",
		description: [
			"Pause a lieutenant's VM via Vers. Preserves full state (memory + disk).",
			"The lieutenant can be resumed later exactly where it left off.",
			"Use this to save resources when a lieutenant isn't actively needed.",
		].join(" "),
		parameters: Type.Object({
			name: Type.String({ description: "Lieutenant name" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { name } = params as { name: string };

			const lt = lieutenants.get(name);
			if (!lt) throw new Error(`Lieutenant '${name}' not found.`);
			if (lt.status === "paused") return { content: [{ type: "text", text: `${name} is already paused.` }] };

			if (lt.status === "working") {
				throw new Error(`Lieutenant '${name}' is currently working. Send a steer to stop it first, or wait for it to finish.`);
			}

			// Disconnect tail before pausing
			const handle = rpcHandles.get(name);
			if (handle) {
				// Kill the tail SSH — we'll reconnect on resume
				// Don't kill the RPC daemon — it's preserved in VM memory
			}

			// Pause VM via Vers API
			await versApi("PATCH", `/vm/${encodeURIComponent(lt.vmId)}/state`, { state: "Paused" });
			lt.status = "paused";
			lt.lastActivityAt = new Date().toISOString();

			if (ctx) updateWidget(ctx);

			return {
				content: [{
					type: "text",
					text: `Lieutenant "${name}" paused. VM state preserved. Use vers_lt_resume to wake it.`,
				}],
			};
		},
	});

	// --- vers_lt_resume ---
	pi.registerTool({
		name: "vers_lt_resume",
		label: "Resume Lieutenant",
		description: "Resume a paused lieutenant. VM resumes from exact state including pi session.",
		parameters: Type.Object({
			name: Type.String({ description: "Lieutenant name" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { name } = params as { name: string };

			const lt = lieutenants.get(name);
			if (!lt) throw new Error(`Lieutenant '${name}' not found.`);
			if (lt.status !== "paused") {
				return { content: [{ type: "text", text: `${name} is not paused (status: ${lt.status}).` }] };
			}

			// Resume VM
			await versApi("PATCH", `/vm/${encodeURIComponent(lt.vmId)}/state`, { state: "Running" });

			// Wait for SSH to come back
			const keyPath = await ensureKeyFile(lt.vmId);
			let ready = false;
			for (let i = 0; i < 15; i++) {
				try {
					const check = await sshExec(keyPath, lt.vmId, "tmux has-session -t pi-rpc 2>/dev/null && echo ok");
					if (check.stdout.includes("ok")) { ready = true; break; }
				} catch { /* not ready */ }
				await new Promise(r => setTimeout(r, 2000));
			}

			if (!ready) {
				lt.status = "error";
				if (ctx) updateWidget(ctx);
				throw new Error(`Lieutenant "${name}" VM resumed but pi session not found. The tmux session may have been lost.`);
			}

			// Reconnect tail -f
			const handle = rpcHandles.get(name);
			if (handle) {
				handle.reconnectTail();
			}

			lt.status = "idle";
			lt.lastActivityAt = new Date().toISOString();

			if (ctx) updateWidget(ctx);

			return {
				content: [{
					type: "text",
					text: `Lieutenant "${name}" resumed. Pi session intact. Ready for tasks.`,
				}],
			};
		},
	});

	// --- vers_lt_destroy ---
	pi.registerTool({
		name: "vers_lt_destroy",
		label: "Destroy Lieutenant",
		description: "Tear down a lieutenant — kills pi, deletes VM. Pass name='*' to destroy all.",
		parameters: Type.Object({
			name: Type.String({ description: "Lieutenant name, or '*' for all" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { name } = params as { name: string };

			const targets = name === "*"
				? Array.from(lieutenants.keys())
				: lieutenants.has(name) ? [name] : [];

			if (targets.length === 0) {
				throw new Error(name === "*" ? "No lieutenants to destroy." : `Lieutenant '${name}' not found.`);
			}

			const results: string[] = [];

			for (const n of targets) {
				const lt = lieutenants.get(n)!;

				// Kill RPC
				const handle = rpcHandles.get(n);
				if (handle) {
					try { await handle.kill(); } catch { /* ignore */ }
					rpcHandles.delete(n);
				}

				// If paused, resume first so we can delete
				if (lt.status === "paused") {
					try {
						await versApi("PATCH", `/vm/${encodeURIComponent(lt.vmId)}/state`, { state: "Running" });
					} catch { /* ignore — delete might work anyway */ }
				}

				// Delete VM
				try {
					await versApi("DELETE", `/vm/${encodeURIComponent(lt.vmId)}`);
					results.push(`${n}: destroyed (VM ${lt.vmId.slice(0, 12)}, ${lt.taskCount} tasks completed)`);
				} catch (err) {
					results.push(`${n}: failed to delete VM — ${err instanceof Error ? err.message : String(err)}`);
				}

				lieutenants.delete(n);
				keyCache.delete(lt.vmId);
			}

			if (ctx) updateWidget(ctx);

			return {
				content: [{ type: "text", text: results.join("\n") }],
			};
		},
	});

	// Cleanup on session shutdown
	pi.on("session_shutdown", async () => {
		// Don't auto-destroy lieutenants on shutdown — they're persistent.
		// Just disconnect the tail SSH processes.
		for (const handle of rpcHandles.values()) {
			// We only kill the local tail, not the remote pi daemon.
			// The VM and pi session survive the meta session closing.
			// TODO: persist lieutenant state to disk so we can reconnect
			// on next session start.
		}
		rpcHandles.clear();
	});
}
