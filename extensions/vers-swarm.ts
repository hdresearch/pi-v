/**
 * Vers Swarm Extension (pi adapter)
 *
 * Thin wrapper around the core SwarmManager.
 * Registers swarm tools and provides the TUI widget.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { VersClient } from "../src/core/vers-client.js";
import { SwarmManager } from "../src/core/swarm.js";

export default function versSwarmExtension(pi: ExtensionAPI) {
	let manager: SwarmManager | undefined;

	function getManager(): SwarmManager {
		if (!manager) {
			// Try to reuse client from vers-vm extension, otherwise create fresh
			const getClient = (pi as any).__versGetClient;
			const client = getClient ? getClient() : new VersClient();
			manager = new SwarmManager(client);
		}
		return manager;
	}

	function updateWidget(ctx?: { ui: { setWidget: (key: string, lines: string[] | undefined) => void } }) {
		if (!ctx) return;
		const agents = getManager().getAgents();
		if (agents.length === 0) {
			ctx.ui.setWidget("vers-swarm", undefined);
			return;
		}
		const lines: string[] = [`─── Swarm (${agents.length}) ───`];
		for (const a of agents) {
			const icon = a.status === "working" ? "⟳" : a.status === "done" ? "✓" : a.status === "error" ? "✗" : "○";
			lines.push(`${icon} ${a.id}: ${a.status}${a.task ? ` — ${a.task.slice(0, 40)}` : ""}`);
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
				commitId: string; count: number; labels?: string[];
				anthropicApiKey: string; model?: string;
			};

			const result = await getManager().spawn({ commitId, count, labels, anthropicApiKey, model });
			if (ctx) updateWidget(ctx);

			return {
				content: [{ type: "text", text: `Spawned ${count} agent(s):\n${result.messages.join("\n")}\n\n${getManager().agentSummary()}` }],
				details: { agents: result.agents },
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
			getManager().sendTask(agentId, task);
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
			const result = await getManager().wait(agentIds, timeoutSeconds, signal);
			if (ctx) updateWidget(ctx);

			const output = result.agents.map(a => `=== ${a.id} [${a.status}] ===\n${a.output}\n`).join("\n");
			return {
				content: [{
					type: "text",
					text: `${result.timedOut ? "TIMED OUT after" : "All agents finished in"} ${result.elapsed}s\n\n${output}`,
				}],
				details: { elapsed: result.elapsed, timedOut: result.timedOut, agents: result.agents.map(a => a.id) },
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
			const agents = getManager().getAgents();
			return {
				content: [{ type: "text", text: getManager().agentSummary() }],
				details: {
					agents: agents.map(a => ({
						id: a.id, vmId: a.vmId, status: a.status,
						task: a.task, outputLength: a.lastOutput.length, eventCount: a.events.length,
					})),
				},
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
			const agent = getManager().getAgent(agentId);
			if (!agent) throw new Error(`Agent '${agentId}' not found. Available: ${getManager().getAgentIds().join(", ")}`);

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
			const results = await getManager().teardown();
			if (ctx) updateWidget(ctx);
			return {
				content: [{ type: "text", text: `Swarm torn down:\n${results.join("\n")}` }],
				details: {},
			};
		},
	});

	// Clean up on session shutdown
	pi.on("session_shutdown", async () => {
		if (manager) await manager.shutdown();
	});
}
