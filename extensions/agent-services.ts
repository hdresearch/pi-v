/**
 * Agent Services Extension
 *
 * Tools for interacting with vers-agent-services (board, feed, registry)
 * running on an infra VM. Configure via VERS_INFRA_URL environment variable.
 *
 * Board tools:
 *   board_create_task  — Create a task on the shared board
 *   board_list_tasks   — List tasks with optional filters
 *   board_update_task  — Update a task
 *   board_add_note     — Add a note/finding to a task
 *
 * Feed tools:
 *   feed_publish       — Publish an event to the activity feed
 *   feed_list          — List recent events
 *   feed_stats         — Get feed statistics
 *
 * Registry tools:
 *   registry_list      — List registered VMs
 *   registry_register  — Register a VM in the registry
 *   registry_discover  — Quick lookup: find VMs by role
 *   registry_heartbeat — Send heartbeat for a registered VM
 *
 * Auto-publishes agent_started/agent_stopped events to the feed.
 * Shows a compact status widget in pi's TUI.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { hostname } from "node:os";

// =============================================================================
// Configuration
// =============================================================================

function getInfraUrl(): string | null {
	return process.env.VERS_INFRA_URL || null;
}

function getAgentName(): string {
	return process.env.AGENT_NAME || process.env.HOSTNAME || hostname() || "unknown-agent";
}

const NOT_CONFIGURED_MSG =
	"Agent services not configured. Set VERS_INFRA_URL environment variable (e.g., http://localhost:3000).";

// =============================================================================
// API Helper
// =============================================================================

async function api(
	infraUrl: string,
	method: string,
	path: string,
	body?: unknown,
): Promise<any> {
	const url = `${infraUrl}${path}`;

	let res: Response;
	try {
		res = await fetch(url, {
			method,
			headers: { "Content-Type": "application/json" },
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
	} catch (err) {
		throw new Error(
			`Cannot reach agent services at ${url}. ` +
				`Check that the infra VM is running. Error: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`Agent services ${method} ${path} failed (${res.status}): ${text}`);
	}

	const ct = res.headers.get("content-type") || "";
	if (ct.includes("application/json")) return res.json();
	const text = await res.text();
	return text || undefined;
}

/**
 * Non-throwing publish helper for auto-events.
 * Silently swallows errors so lifecycle hooks never crash the extension.
 */
async function publishToFeed(
	infraUrl: string | null,
	event: { agent: string; type: string; summary: string; detail?: string },
): Promise<void> {
	if (!infraUrl) return;
	try {
		await api(infraUrl, "POST", "/feed/events", event);
	} catch {
		// Swallow — auto-publish should never crash
	}
}

// =============================================================================
// Extension
// =============================================================================

export default function agentServicesExtension(pi: ExtensionAPI) {
	let widgetInterval: ReturnType<typeof setInterval> | undefined;
	let latestCtx: { ui: { setWidget: (key: string, lines: string[] | undefined) => void } } | undefined;

	// Helper that checks infra URL or returns an error result
	function requireInfra(): string {
		const url = getInfraUrl();
		if (!url) throw new Error(NOT_CONFIGURED_MSG);
		return url;
	}

	// =========================================================================
	// Board Tools
	// =========================================================================

	pi.registerTool({
		name: "board_create_task",
		label: "Create Board Task",
		description: "Create a task on the shared board.",
		parameters: Type.Object({
			title: Type.String({ description: "Task title" }),
			description: Type.Optional(Type.String({ description: "Task description" })),
			assignee: Type.Optional(Type.String({ description: "Assigned agent/person" })),
			tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization" })),
			createdBy: Type.String({ description: "Who is creating this task" }),
		}),
		async execute(_id, params) {
			const infraUrl = requireInfra();
			const result = await api(infraUrl, "POST", "/board/tasks", params);
			return {
				content: [{ type: "text", text: `Task created: ${JSON.stringify(result, null, 2)}` }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "board_list_tasks",
		label: "List Board Tasks",
		description: "List tasks on the shared board with optional filters.",
		parameters: Type.Object({
			status: Type.Optional(Type.String({ description: "Filter by status (e.g., open, in_progress, done, blocked)" })),
			assignee: Type.Optional(Type.String({ description: "Filter by assignee" })),
			tag: Type.Optional(Type.String({ description: "Filter by tag" })),
		}),
		async execute(_id, params) {
			const infraUrl = requireInfra();
			const { status, assignee, tag } = params as { status?: string; assignee?: string; tag?: string };

			const query = new URLSearchParams();
			if (status) query.set("status", status);
			if (assignee) query.set("assignee", assignee);
			if (tag) query.set("tag", tag);

			const qs = query.toString();
			const path = `/board/tasks${qs ? `?${qs}` : ""}`;
			const result = await api(infraUrl, "GET", path);

			const tasks = Array.isArray(result) ? result : result?.tasks || [];
			let text = `${tasks.length} task(s) found`;
			if (status || assignee || tag) {
				const filters = [status && `status=${status}`, assignee && `assignee=${assignee}`, tag && `tag=${tag}`]
					.filter(Boolean)
					.join(", ");
				text += ` (filters: ${filters})`;
			}
			text += `\n\n${JSON.stringify(tasks, null, 2)}`;

			return {
				content: [{ type: "text", text }],
				details: { tasks },
			};
		},
	});

	pi.registerTool({
		name: "board_update_task",
		label: "Update Board Task",
		description: "Update a task on the shared board.",
		parameters: Type.Object({
			id: Type.String({ description: "Task ID to update" }),
			status: Type.Optional(Type.String({ description: "New status" })),
			assignee: Type.Optional(Type.String({ description: "New assignee" })),
			title: Type.Optional(Type.String({ description: "New title" })),
			tags: Type.Optional(Type.Array(Type.String(), { description: "New tags" })),
		}),
		async execute(_id, params) {
			const infraUrl = requireInfra();
			const { id, ...updates } = params as { id: string; [key: string]: any };
			const result = await api(infraUrl, "PATCH", `/board/tasks/${encodeURIComponent(id)}`, updates);
			return {
				content: [{ type: "text", text: `Task ${id} updated: ${JSON.stringify(result, null, 2)}` }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "board_add_note",
		label: "Add Note to Task",
		description: "Add a note/finding to a task on the shared board.",
		parameters: Type.Object({
			taskId: Type.String({ description: "Task ID to add note to" }),
			author: Type.String({ description: "Note author" }),
			content: Type.String({ description: "Note content" }),
			type: StringEnum(["finding", "blocker", "question", "update"] as const, {
				description: "Note type",
			}),
		}),
		async execute(_id, params) {
			const infraUrl = requireInfra();
			const { taskId, ...noteData } = params as { taskId: string; author: string; content: string; type: string };
			const result = await api(
				infraUrl,
				"POST",
				`/board/tasks/${encodeURIComponent(taskId)}/notes`,
				noteData,
			);
			return {
				content: [{ type: "text", text: `Note added to task ${taskId}: ${JSON.stringify(result, null, 2)}` }],
				details: result,
			};
		},
	});

	// =========================================================================
	// Feed Tools
	// =========================================================================

	pi.registerTool({
		name: "feed_publish",
		label: "Publish Feed Event",
		description: "Publish an event to the activity feed.",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name/ID publishing the event" }),
			type: Type.String({ description: "Event type (e.g., task_started, finding, error)" }),
			summary: Type.String({ description: "Short summary of the event" }),
			detail: Type.Optional(Type.String({ description: "Detailed information" })),
		}),
		async execute(_id, params) {
			const infraUrl = requireInfra();
			const result = await api(infraUrl, "POST", "/feed/events", params);
			return {
				content: [{ type: "text", text: `Event published: ${JSON.stringify(result, null, 2)}` }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "feed_list",
		label: "List Feed Events",
		description: "List recent events from the activity feed.",
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Filter by agent" })),
			type: Type.Optional(Type.String({ description: "Filter by event type" })),
			limit: Type.Optional(Type.Number({ description: "Max events to return (default: 50)" })),
		}),
		async execute(_id, params) {
			const infraUrl = requireInfra();
			const { agent, type, limit } = params as { agent?: string; type?: string; limit?: number };

			const query = new URLSearchParams();
			if (agent) query.set("agent", agent);
			if (type) query.set("type", type);
			if (limit !== undefined) query.set("limit", String(limit));

			const qs = query.toString();
			const path = `/feed/events${qs ? `?${qs}` : ""}`;
			const result = await api(infraUrl, "GET", path);

			const events = Array.isArray(result) ? result : result?.events || [];
			return {
				content: [{ type: "text", text: `${events.length} event(s)\n\n${JSON.stringify(events, null, 2)}` }],
				details: { events },
			};
		},
	});

	pi.registerTool({
		name: "feed_stats",
		label: "Feed Statistics",
		description: "Get feed statistics (events by agent, by type).",
		parameters: Type.Object({}),
		async execute() {
			const infraUrl = requireInfra();
			const result = await api(infraUrl, "GET", "/feed/stats");
			return {
				content: [{ type: "text", text: `Feed stats:\n${JSON.stringify(result, null, 2)}` }],
				details: result,
			};
		},
	});

	// =========================================================================
	// Registry Tools
	// =========================================================================

	pi.registerTool({
		name: "registry_list",
		label: "List Registered VMs",
		description: "List VMs registered in the service registry.",
		parameters: Type.Object({
			role: Type.Optional(Type.String({ description: "Filter by role" })),
			status: Type.Optional(Type.String({ description: "Filter by status (e.g., running, stopped)" })),
		}),
		async execute(_id, params) {
			const infraUrl = requireInfra();
			const { role, status } = params as { role?: string; status?: string };

			const query = new URLSearchParams();
			if (role) query.set("role", role);
			if (status) query.set("status", status);

			const qs = query.toString();
			const path = `/registry/vms${qs ? `?${qs}` : ""}`;
			const result = await api(infraUrl, "GET", path);

			const vms = Array.isArray(result) ? result : result?.vms || [];
			return {
				content: [{ type: "text", text: `${vms.length} VM(s) registered\n\n${JSON.stringify(vms, null, 2)}` }],
				details: { vms },
			};
		},
	});

	pi.registerTool({
		name: "registry_register",
		label: "Register VM",
		description: "Register a VM in the service registry.",
		parameters: Type.Object({
			id: Type.String({ description: "VM ID" }),
			name: Type.String({ description: "Human-readable name" }),
			role: Type.String({ description: "VM role (e.g., worker, coordinator, infra)" }),
			address: Type.String({ description: "VM address/hostname" }),
			services: Type.Optional(Type.Array(Type.Object({}), { description: "Services running on the VM" })),
			registeredBy: Type.String({ description: "Who is registering this VM" }),
		}),
		async execute(_id, params) {
			const infraUrl = requireInfra();
			const result = await api(infraUrl, "POST", "/registry/vms", params);
			return {
				content: [{ type: "text", text: `VM registered: ${JSON.stringify(result, null, 2)}` }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "registry_discover",
		label: "Discover VMs by Role",
		description: "Quick lookup: find VMs by role in the service registry.",
		parameters: Type.Object({
			role: Type.String({ description: "Role to search for" }),
		}),
		async execute(_id, params) {
			const infraUrl = requireInfra();
			const { role } = params as { role: string };
			const result = await api(infraUrl, "GET", `/registry/vms?role=${encodeURIComponent(role)}`);

			const vms = Array.isArray(result) ? result : result?.vms || [];
			return {
				content: [
					{
						type: "text",
						text: vms.length > 0
							? `Found ${vms.length} VM(s) with role "${role}":\n\n${JSON.stringify(vms, null, 2)}`
							: `No VMs found with role "${role}".`,
					},
				],
				details: { role, vms },
			};
		},
	});

	pi.registerTool({
		name: "registry_heartbeat",
		label: "VM Heartbeat",
		description: "Send heartbeat for a registered VM to indicate it is alive.",
		parameters: Type.Object({
			id: Type.String({ description: "VM ID to heartbeat" }),
		}),
		async execute(_id, params) {
			const infraUrl = requireInfra();
			const { id } = params as { id: string };
			const result = await api(infraUrl, "POST", `/registry/vms/${encodeURIComponent(id)}/heartbeat`);
			return {
				content: [{ type: "text", text: `Heartbeat sent for VM ${id}.` }],
				details: result,
			};
		},
	});

	// =========================================================================
	// Auto-publish to Feed
	// =========================================================================

	pi.on("agent_start", async () => {
		const infraUrl = getInfraUrl();
		await publishToFeed(infraUrl, {
			agent: getAgentName(),
			type: "agent_started",
			summary: `Agent started on ${hostname()}`,
		});
	});

	pi.on("agent_end", async () => {
		const infraUrl = getInfraUrl();
		await publishToFeed(infraUrl, {
			agent: getAgentName(),
			type: "agent_stopped",
			summary: `Agent completed task`,
		});
	});

	// =========================================================================
	// Status Widget (polls every 30s)
	// =========================================================================

	async function updateWidget() {
		if (!latestCtx) return;
		const infraUrl = getInfraUrl();
		if (!infraUrl) {
			latestCtx.ui.setWidget("agent-services", ["─── Agent Services ───", "Not configured (set VERS_INFRA_URL)"]);
			return;
		}

		try {
			// Fetch stats in parallel, each with its own error handling
			const [boardResult, feedResult, registryResult] = await Promise.allSettled([
				api(infraUrl, "GET", "/board/tasks"),
				api(infraUrl, "GET", "/feed/stats"),
				api(infraUrl, "GET", "/registry/vms"),
			]);

			// Board summary
			let boardLine = "Board: unavailable";
			if (boardResult.status === "fulfilled") {
				const tasks = Array.isArray(boardResult.value) ? boardResult.value : boardResult.value?.tasks || [];
				const open = tasks.filter((t: any) => t.status === "open" || t.status === "todo" || t.status === "in_progress").length;
				const blocked = tasks.filter((t: any) => t.status === "blocked").length;
				boardLine = `Board: ${open} open${blocked > 0 ? `, ${blocked} blocked` : ""}`;
			}

			// Feed summary
			let feedLine = "Feed: unavailable";
			if (feedResult.status === "fulfilled") {
				const stats = feedResult.value;
				const totalEvents = stats?.totalEvents ?? stats?.total ?? "?";
				const lastEvent = stats?.lastEventAge ?? stats?.lastEvent;
				feedLine = `Feed: ${totalEvents} events`;
				if (lastEvent) feedLine += ` (last: ${lastEvent})`;
			}

			// Registry summary
			let registryLine = "Registry: unavailable";
			if (registryResult.status === "fulfilled") {
				const vms = Array.isArray(registryResult.value)
					? registryResult.value
					: registryResult.value?.vms || [];
				const running = vms.filter((v: any) => v.status === "running").length;
				registryLine = `Registry: ${vms.length} VMs (${running} running)`;
			}

			latestCtx.ui.setWidget("agent-services", [
				"─── Agent Services ───",
				boardLine,
				feedLine,
				registryLine,
			]);
		} catch {
			latestCtx.ui.setWidget("agent-services", [
				"─── Agent Services ───",
				"Error fetching status",
			]);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;

		// Initial widget update
		await updateWidget();

		// Poll every 30 seconds
		if (widgetInterval) clearInterval(widgetInterval);
		widgetInterval = setInterval(() => updateWidget(), 30_000);
	});

	pi.on("session_shutdown", async () => {
		if (widgetInterval) {
			clearInterval(widgetInterval);
			widgetInterval = undefined;
		}
	});
}
