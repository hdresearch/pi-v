/**
 * Vers Swarm Extension
 *
 * Orchestrate a swarm of pi coding agents running on Vers VMs.
 * Each agent runs pi in RPC mode inside a branched VM.
 *
 * Tools:
 *   vers_swarm_spawn    - Branch N VMs from a commit and start pi agents
 *   vers_swarm_task     - Send a task to a specific agent
 *   vers_swarm_status   - Check status of all agents
 *   vers_swarm_read     - Read an agent's latest output
 *   vers_swarm_wait     - Block until all/specified agents finish, return results
 *   vers_swarm_teardown - Destroy all swarm VMs
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

interface SwarmAgent {
	id: string;
	vmId: string;
	label: string;
	status: "starting" | "idle" | "working" | "done" | "error";
	task?: string;
	lastOutput: string;
	events: string[];
}

// =============================================================================
// Vers API helpers (minimal, just what swarm needs)
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

const keyCache = new Map<string, string>(); // vmId -> keyPath

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
		"-o", `ProxyCommand=openssl s_client -connect %h:443 -servername %h -quiet 2>/dev/null`,
		`root@${vmId}.vm.vers.sh`,
	];
}

/** Run a one-shot SSH command */
function sshExec(keyPath: string, vmId: string, command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolve, reject) => {
		const args = sshArgs(keyPath, vmId);
		const child = spawn("ssh", [...args, command], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
		child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
		child.on("error", reject);
		child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
	});
}

/**
 * Start pi in RPC mode on a VM via SSH.
 * Returns a handle to send commands and read events.
 */
interface StartRpcOptions {
	anthropicApiKey: string;
	versApiKey?: string;
	versBaseUrl?: string;
}

function startRpcAgent(keyPath: string, vmId: string, opts: StartRpcOptions): {
	send: (cmd: object) => void;
	onEvent: (handler: (event: any) => void) => void;
	kill: () => void;
	process: ReturnType<typeof spawn>;
} {
	const args = sshArgs(keyPath, vmId);
	// Set env vars for LLM + Vers access, then start pi in RPC mode
	const envVars = [
		`export ANTHROPIC_API_KEY=${opts.anthropicApiKey}`,
		opts.versApiKey ? `export VERS_API_KEY=${opts.versApiKey}` : "",
		opts.versBaseUrl ? `export VERS_BASE_URL=${opts.versBaseUrl}` : "",
	].filter(Boolean).join("; ");
	const remoteCmd = `${envVars}; cd /root/workspace; pi --mode rpc --no-session`;

	const child = spawn("ssh", [...args, remoteCmd], {
		stdio: ["pipe", "pipe", "pipe"],
	});

	let eventHandler: ((event: any) => void) | undefined;
	let lineBuf = "";

	let stderrLog = "";
	child.stderr.on("data", (d: Buffer) => { stderrLog += d.toString(); });
	child.on("close", (code) => {
		if (stderrLog) console.error(`[vers-swarm] pi RPC on ${vmId.slice(0, 12)} exited (code ${code}): ${stderrLog.slice(0, 500)}`);
	});

	child.stdout.on("data", (data: Buffer) => {
		lineBuf += data.toString();
		const lines = lineBuf.split("\n");
		lineBuf = lines.pop() || "";
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line);
				if (eventHandler) eventHandler(event);
			} catch {
				// not JSON, ignore
			}
		}
	});

	return {
		send: (cmd: object) => {
			child.stdin.write(JSON.stringify(cmd) + "\n");
		},
		onEvent: (handler) => { eventHandler = handler; },
		kill: () => {
			child.stdin.end();
			child.kill("SIGTERM");
		},
		process: child,
	};
}

// =============================================================================
// Extension
// =============================================================================

export default function versSwarmExtension(pi: ExtensionAPI) {
	const agents = new Map<string, SwarmAgent>();
	const rpcHandles = new Map<string, ReturnType<typeof startRpcAgent>>();

	function agentSummary(): string {
		if (agents.size === 0) return "No agents in swarm.";
		const lines = [];
		for (const [id, a] of agents) {
			const task = a.task ? ` — ${a.task.slice(0, 60)}` : "";
			lines.push(`  ${id} [${a.status}] (${a.vmId.slice(0, 12)})${task}`);
		}
		return `Swarm (${agents.size} agents):\n${lines.join("\n")}`;
	}

	function updateWidget(ctx?: { ui: { setWidget: (key: string, lines: string[] | undefined) => void } }) {
		if (!ctx) return;
		if (agents.size === 0) {
			ctx.ui.setWidget("vers-swarm", undefined);
			return;
		}
		const lines: string[] = [`─── Swarm (${agents.size}) ───`];
		for (const [id, a] of agents) {
			const icon = a.status === "working" ? "⟳" : a.status === "done" ? "✓" : a.status === "error" ? "✗" : "○";
			lines.push(`${icon} ${id}: ${a.status}${a.task ? ` — ${a.task.slice(0, 40)}` : ""}`);
		}
		ctx.ui.setWidget("vers-swarm", lines);
	}

	// --- vers_swarm_spawn ---
	pi.registerTool({
		name: "vers_swarm_spawn",
		label: "Spawn Agent Swarm",
		description: "Branch N VMs from a golden commit and start pi coding agents on each. Each agent runs pi in RPC mode, ready to receive tasks.",
		parameters: Type.Object({
			commitId: Type.String({ description: "Golden image commit ID to branch from" }),
			count: Type.Number({ description: "Number of agents to spawn" }),
			labels: Type.Optional(Type.Array(Type.String(), { description: "Labels for each agent (e.g., ['feature', 'tests', 'docs'])" })),
			anthropicApiKey: Type.String({ description: "Anthropic API key for the agents to use" }),
			model: Type.Optional(Type.String({ description: "Model ID for agents (default: claude-sonnet-4-20250514)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { commitId, count, labels, anthropicApiKey, model } = params as {
				commitId: string;
				count: number;
				labels?: string[];
				anthropicApiKey: string;
				model?: string;
			};

			// Resolve Vers credentials for child agents
			const versApiKey = loadApiKey();
			const versBaseUrl = process.env.VERS_BASE_URL || "https://api.vers.sh/api/v1";

			// Use first spawned VM as root for status reporting (or reuse existing)
			let rootVmId = "";

			const results: string[] = [];

			for (let i = 0; i < count; i++) {
				const label = labels?.[i] || `agent-${i + 1}`;

				// Restore a new VM from the golden commit
				const vm = await versApi<{ vm_id: string }>("POST", "/vm/from_commit", { commit_id: commitId });
				const vmId = vm.vm_id;
				if (i === 0) rootVmId = vmId;

				// Wait for boot
				let retries = 30;
				while (retries > 0) {
					try {
						const keyPath = await ensureKeyFile(vmId);
						const check = await sshExec(keyPath, vmId, "echo ready");
						if (check.stdout.trim() === "ready") break;
					} catch { /* not ready yet */ }
					await new Promise(r => setTimeout(r, 2000));
					retries--;
				}
				if (retries === 0) {
					results.push(`${label}: FAILED to boot VM ${vmId}`);
					continue;
				}

				// Inject identity.json so the agent knows who it is
				const keyPath = await ensureKeyFile(vmId);
				const identity = JSON.stringify({
					vmId,
					agentId: label,
					rootVmId,
					parentVmId: "local",
					depth: 1,
					maxDepth: 50,
					maxVms: 20,
					createdAt: new Date().toISOString(),
				});
				await sshExec(keyPath, vmId, `cat > /root/.swarm/identity.json << 'IDENTITY_EOF'\n${identity}\nIDENTITY_EOF`);

				// Initialize status dir and registry on root VM
				if (i === 0) {
					await sshExec(keyPath, vmId, `mkdir -p /root/.swarm/status && echo '{"vms":[]}' > /root/.swarm/registry.json`);
				}

				// Start pi RPC agent with Vers credentials
				const handle = startRpcAgent(keyPath, vmId, {
					anthropicApiKey,
					versApiKey,
					versBaseUrl,
				});

				const agent: SwarmAgent = {
					id: label,
					vmId,
					label,
					status: "idle",
					lastOutput: "",
					events: [],
				};

				// Wait for pi RPC to be ready by sending get_state
				const rpcReady = await new Promise<boolean>((resolve) => {
					const timeout = setTimeout(() => resolve(false), 30000);
					handle.onEvent((event) => {
						if (event.type === "response" && event.command === "get_state") {
							clearTimeout(timeout);
							resolve(true);
						}
					});
					// Give SSH + pi a moment to start
					setTimeout(() => {
						handle.send({ id: "startup-check", type: "get_state" });
					}, 2000);
				});

				if (!rpcReady) {
					results.push(`${label}: VM ${vmId.slice(0, 12)} booted but pi RPC failed to start`);
					handle.kill();
					continue;
				}

				// Now install the real event handler
				handle.onEvent((event) => {
					agent.events.push(JSON.stringify(event));
					// Keep last 200 events
					if (agent.events.length > 200) agent.events.shift();

					if (event.type === "agent_start") {
						agent.status = "working";
					} else if (event.type === "agent_end") {
						agent.status = "done";
					} else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
						agent.lastOutput += event.assistantMessageEvent.delta;
					}
				});

				// Set model if specified
				if (model) {
					handle.send({ type: "set_model", provider: "anthropic", modelId: model });
				}

				agents.set(label, agent);
				rpcHandles.set(label, handle);
				results.push(`${label}: VM ${vmId.slice(0, 12)} — ready`);
			}

			if (ctx) updateWidget(ctx);

			return {
				content: [{ type: "text", text: `Spawned ${count} agent(s):\n${results.join("\n")}\n\n${agentSummary()}` }],
				details: { agents: Array.from(agents.values()).map(a => ({ id: a.id, vmId: a.vmId, status: a.status })) },
			};
		},
	});

	// --- vers_swarm_task ---
	pi.registerTool({
		name: "vers_swarm_task",
		label: "Send Task to Agent",
		description: "Send a task (prompt) to a specific swarm agent. The agent will begin working on it autonomously.",
		parameters: Type.Object({
			agentId: Type.String({ description: "Agent label/ID to send task to" }),
			task: Type.String({ description: "The task prompt to send" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { agentId, task } = params as { agentId: string; task: string };

			const agent = agents.get(agentId);
			if (!agent) throw new Error(`Agent '${agentId}' not found. Available: ${Array.from(agents.keys()).join(", ")}`);

			const handle = rpcHandles.get(agentId);
			if (!handle) throw new Error(`No RPC handle for agent '${agentId}'`);

			agent.task = task;
			agent.status = "working";
			agent.lastOutput = "";

			handle.send({ type: "prompt", message: task });

			if (ctx) updateWidget(ctx);

			return {
				content: [{ type: "text", text: `Task sent to ${agentId}: "${task.slice(0, 100)}${task.length > 100 ? "..." : ""}"` }],
				details: { agentId, task },
			};
		},
	});

	// --- vers_swarm_wait ---
	pi.registerTool({
		name: "vers_swarm_wait",
		label: "Wait for Agents",
		description: "Block until all agents (or specified agents) finish. Returns each agent's full text output. Use after dispatching tasks to collect results without polling.",
		parameters: Type.Object({
			agentIds: Type.Optional(Type.Array(Type.String(), { description: "Specific agent IDs to wait for (default: all working/idle agents)" })),
			timeoutSeconds: Type.Optional(Type.Number({ description: "Max seconds to wait (default: 300)" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const { agentIds, timeoutSeconds } = params as { agentIds?: string[]; timeoutSeconds?: number };
			const timeout = (timeoutSeconds || 300) * 1000;
			const startTime = Date.now();

			// Determine which agents to wait for
			const targetIds = agentIds || Array.from(agents.keys());
			const waiting = targetIds.filter(id => {
				const a = agents.get(id);
				return a && (a.status === "working" || a.status === "idle");
			});

			if (waiting.length === 0) {
				// All already done, return results immediately
				const results: string[] = [];
				for (const id of targetIds) {
					const a = agents.get(id);
					if (!a) continue;
					results.push(`=== ${id} [${a.status}] ===\n${a.lastOutput || "(no output)"}\n`);
				}
				return {
					content: [{ type: "text", text: results.join("\n") }],
					details: { waited: 0, agents: targetIds },
				};
			}

			// Poll until all done or timeout
			await new Promise<void>((resolve) => {
				const check = () => {
					// Check abort signal
					if (signal?.aborted) { resolve(); return; }

					// Check if all target agents are done
					const allDone = waiting.every(id => {
						const a = agents.get(id);
						return !a || a.status === "done" || a.status === "error";
					});

					if (allDone || Date.now() - startTime > timeout) {
						resolve();
						return;
					}

					if (ctx) updateWidget(ctx);
					setTimeout(check, 2000);
				};
				check();
			});

			const elapsed = Math.round((Date.now() - startTime) / 1000);
			const results: string[] = [];
			for (const id of targetIds) {
				const a = agents.get(id);
				if (!a) continue;
				results.push(`=== ${id} [${a.status}] ===\n${a.lastOutput || "(no output)"}\n`);
			}

			if (ctx) updateWidget(ctx);

			const timedOut = waiting.some(id => {
				const a = agents.get(id);
				return a && a.status === "working";
			});

			return {
				content: [{
					type: "text",
					text: `${timedOut ? "TIMED OUT after" : "All agents finished in"} ${elapsed}s\n\n${results.join("\n")}`,
				}],
				details: { elapsed, timedOut, agents: targetIds },
			};
		},
	});

	// --- vers_swarm_status ---
	pi.registerTool({
		name: "vers_swarm_status",
		label: "Swarm Status",
		description: "Check the status of all agents in the swarm. Shows which are idle, working, done, or errored.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			if (ctx) updateWidget(ctx);

			const agentDetails = Array.from(agents.values()).map(a => ({
				id: a.id,
				vmId: a.vmId,
				status: a.status,
				task: a.task,
				outputLength: a.lastOutput.length,
				eventCount: a.events.length,
			}));

			return {
				content: [{ type: "text", text: agentSummary() }],
				details: { agents: agentDetails },
			};
		},
	});

	// --- vers_swarm_read ---
	pi.registerTool({
		name: "vers_swarm_read",
		label: "Read Agent Output",
		description: "Read the latest text output from a specific swarm agent. Returns the agent's accumulated response text.",
		parameters: Type.Object({
			agentId: Type.String({ description: "Agent label/ID to read from" }),
			tail: Type.Optional(Type.Number({ description: "Number of characters from the end to return (default: all)" })),
		}),
		async execute(_id, params) {
			const { agentId, tail } = params as { agentId: string; tail?: number };

			const agent = agents.get(agentId);
			if (!agent) throw new Error(`Agent '${agentId}' not found. Available: ${Array.from(agents.keys()).join(", ")}`);

			let output = agent.lastOutput || "(no output yet)";
			if (tail && output.length > tail) {
				output = "..." + output.slice(-tail);
			}

			return {
				content: [{ type: "text", text: `[${agentId}] (${agent.status}):\n\n${output}` }],
				details: { agentId, status: agent.status, outputLength: agent.lastOutput.length },
			};
		},
	});

	// --- vers_swarm_teardown ---
	pi.registerTool({
		name: "vers_swarm_teardown",
		label: "Teardown Swarm",
		description: "Stop all swarm agents and delete their VMs.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const results: string[] = [];

			for (const [id, agent] of agents) {
				// Kill RPC process
				const handle = rpcHandles.get(id);
				if (handle) {
					try { handle.kill(); } catch { /* ignore */ }
					rpcHandles.delete(id);
				}

				// Delete VM
				try {
					await versApi("DELETE", `/vm/${encodeURIComponent(agent.vmId)}`);
					results.push(`${id}: VM ${agent.vmId.slice(0, 12)} deleted`);
				} catch (err) {
					results.push(`${id}: failed to delete VM — ${err instanceof Error ? err.message : String(err)}`);
				}
			}

			agents.clear();
			keyCache.clear();
			if (ctx) updateWidget(ctx);

			return {
				content: [{ type: "text", text: `Swarm torn down:\n${results.join("\n")}` }],
				details: {},
			};
		},
	});

	// Clean up on session shutdown
	pi.on("session_shutdown", async () => {
		for (const handle of rpcHandles.values()) {
			try { handle.kill(); } catch { /* ignore */ }
		}
		rpcHandles.clear();
	});
}
