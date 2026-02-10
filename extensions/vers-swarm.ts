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
		"-o", "ServerAliveInterval=15",
		"-o", "ServerAliveCountMax=4",
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
 * Start pi in RPC mode on a VM as a **daemon** (detached from SSH).
 *
 * Architecture:
 *   - pi runs in the background on the VM, reading from a FIFO and writing to a file
 *   - A `sleep infinity` process keeps the FIFO open so pi never gets EOF
 *   - Commands are sent via one-shot SSH writes to the FIFO
 *   - Events are read via `tail -f` over SSH, which auto-reconnects on drop
 *   - If the tail SSH drops, pi stays alive — we just reconnect
 */
interface StartRpcOptions {
	anthropicApiKey: string;
	versApiKey?: string;
	versBaseUrl?: string;
}

const RPC_DIR = "/tmp/pi-rpc";
const RPC_IN = `${RPC_DIR}/in`;     // FIFO — commands written here
const RPC_OUT = `${RPC_DIR}/out`;    // Regular file — pi writes JSON events here
const RPC_ERR = `${RPC_DIR}/err`;    // Regular file — pi stderr
const RPC_PID = `${RPC_DIR}/pi.pid`;
const RPC_KEEPER_PID = `${RPC_DIR}/keeper.pid`;

interface RpcHandle {
	send: (cmd: object) => void;
	onEvent: (handler: (event: any) => void) => void;
	kill: () => Promise<void>;
	vmId: string;
}

async function startRpcAgent(keyPath: string, vmId: string, opts: StartRpcOptions): Promise<RpcHandle> {
	// Build env vars
	const envExports = [
		`export ANTHROPIC_API_KEY='${opts.anthropicApiKey}'`,
		opts.versApiKey ? `export VERS_API_KEY='${opts.versApiKey}'` : "",
		opts.versBaseUrl ? `export VERS_BASE_URL='${opts.versBaseUrl}'` : "",
	].filter(Boolean).join("; ");

	// Step 1: Start pi inside a tmux session on the VM.
	// tmux survives SSH disconnects — if our tail -f drops, pi keeps running.
	const startScript = `
		set -e
		mkdir -p ${RPC_DIR}
		rm -f ${RPC_IN} ${RPC_OUT} ${RPC_ERR} ${RPC_PID} ${RPC_KEEPER_PID}
		mkfifo ${RPC_IN}
		touch ${RPC_OUT} ${RPC_ERR}

		# Keep FIFO open so pi never gets EOF when a writer disconnects
		tmux new-session -d -s pi-keeper "sleep infinity > ${RPC_IN}"

		# Start pi in a tmux session, reading from FIFO, writing to file
		tmux new-session -d -s pi-rpc "${envExports}; cd /root/workspace; pi --mode rpc --no-session < ${RPC_IN} >> ${RPC_OUT} 2>> ${RPC_ERR}"

		# Wait a moment for processes to start
		sleep 1

		# Verify tmux sessions exist
		tmux has-session -t pi-rpc 2>/dev/null && echo "daemon_started" || echo "daemon_failed"
	`;

	const startResult = await sshExec(keyPath, vmId, startScript);
	if (!startResult.stdout.includes("daemon_started")) {
		throw new Error(`Failed to start pi daemon on ${vmId}: ${startResult.stderr || startResult.stdout}`);
	}

	// Step 2: Start tail -f over SSH to read events (reconnectable)
	let eventHandler: ((event: any) => void) | undefined;
	let tailChild: ReturnType<typeof spawn> | null = null;
	let lineBuf = "";
	let killed = false;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let linesProcessed = 0; // Track lines so we skip on reconnect

	function startTail() {
		if (killed) return;
		const args = sshArgs(keyPath, vmId);
		// On reconnect, skip already-processed lines (+1 because tail is 1-indexed)
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
				} catch {
					// not JSON, ignore (tail noise, etc.)
				}
			}
		});

		tailChild.stderr!.on("data", (d: Buffer) => {
			const msg = d.toString().trim();
			if (msg) console.error(`[vers-swarm] tail stderr (${vmId.slice(0, 12)}): ${msg}`);
		});

		tailChild.on("close", (code) => {
			if (killed) return;
			console.error(`[vers-swarm] tail on ${vmId.slice(0, 12)} exited (code ${code}), reconnecting in 3s...`);
			lineBuf = ""; // Reset partial line buffer on reconnect
			// Reconnect after a delay — pi is still alive on the VM
			reconnectTimer = setTimeout(() => startTail(), 3000);
		});
	}

	startTail();

	// Step 3: Send commands via one-shot SSH, piping JSON on stdin to the FIFO.
	// No shell escaping needed — JSON goes straight through stdin.
	function send(cmd: object) {
		if (killed) return;
		const json = JSON.stringify(cmd) + "\n";
		const writeChild = spawn("ssh", [...sshArgs(keyPath, vmId), `cat > ${RPC_IN}`], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		writeChild.stdin.write(json);
		writeChild.stdin.end();
		writeChild.on("error", (err) => {
			console.error(`[vers-swarm] send failed (${vmId.slice(0, 12)}): ${err.message}`);
		});
	}

	// Step 4: Kill — stop pi and cleanup on the VM
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

	return {
		send,
		onEvent: (handler) => { eventHandler = handler; },
		kill,
		vmId,
	};
}

// =============================================================================
// Extension
// =============================================================================

export default function versSwarmExtension(pi: ExtensionAPI) {
	const agents = new Map<string, SwarmAgent>();
	const rpcHandles = new Map<string, RpcHandle>();

	function agentSummary(): string {
		if (agents.size === 0) return "No agents in swarm.";
		const lines = [];
		for (const [id, a] of agents) {
			const task = a.task ? ` — ${a.task.slice(0, 60)}` : "";
			lines.push(`  ${id} [${a.status}] (${a.vmId})${task}`);
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

				// Start pi RPC agent as daemon with Vers credentials
				const handle = await startRpcAgent(keyPath, vmId, {
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
				// The daemon needs a few seconds to start + tail -f needs to connect
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
					// Give daemon + tail time to start, then send check.
					// Retry a few times in case the first send arrives before pi is ready.
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
					results.push(`${label}: VM ${vmId} booted but pi RPC failed to start`);
					await handle.kill();
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
				results.push(`${label}: VM ${vmId} — ready`);
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
				// Kill RPC daemon on VM
				const handle = rpcHandles.get(id);
				if (handle) {
					try { await handle.kill(); } catch { /* ignore */ }
					rpcHandles.delete(id);
				}

				// Delete VM
				try {
					await versApi("DELETE", `/vm/${encodeURIComponent(agent.vmId)}`);
					results.push(`${id}: VM ${agent.vmId} deleted`);
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
			try { await handle.kill(); } catch { /* ignore */ }
		}
		rpcHandles.clear();
	});
}
