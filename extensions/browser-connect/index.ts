/**
 * browser-connect: Zero-friction Chrome control for pi agents via CDP.
 *
 * Connects to the user's REAL Chrome browser — with all their logged-in sessions,
 * cookies, and profiles. No Chrome extension needed. Uses Chrome DevTools Protocol
 * directly, powered by agent-browser CLI.
 *
 * Tools:
 *   browser_launch     - Connect to Chrome or launch with user profile + CDP
 *   browser_go         - Navigate to URL
 *   browser_snapshot   - Accessibility tree with refs (AI-optimized)
 *   browser_click      - Click element by ref or selector
 *   browser_type       - Type into focused/selected element
 *   browser_fill       - Clear + fill input
 *   browser_screenshot - Take screenshot
 *   browser_read       - Get text/html/title/url
 *   browser_tabs       - List and switch tabs
 *   browser_wait       - Wait for element/text/url/load
 *   browser_eval       - Run JavaScript in page
 *   browser_scroll     - Scroll page
 *   browser_find       - Semantic find by role/text/label + action
 *   browser_close      - Disconnect (browser stays open)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	detectChrome,
	ensureChromeWithCdp,
	discoverProfiles,
	isDebugPortOpen,
	getCdpInfo,
	type ChromeProfile,
} from "./chrome.js";
import { run, runDirect, screenshotPath, isInstalled, install } from "./agent-browser.js";

export default function browserConnectExtension(pi: ExtensionAPI) {
	let cdpPort: number | null = null;
	let connectedProfile: string | null = null;

	// ─── Flags ──────────────────────────────────────────────────────────

	pi.registerFlag("chrome-profile", {
		description: "Chrome profile to use (display name or directory name like 'Profile 1')",
		type: "string",
		default: "",
	});

	pi.registerFlag("cdp-port", {
		description: "CDP port (default: 9222)",
		type: "string",
		default: "9222",
	});

	pi.registerFlag("chrome-path", {
		description: "Path to Chrome binary",
		type: "string",
		default: "",
	});

	// ─── Helpers ────────────────────────────────────────────────────────

	function getPort(): number {
		return cdpPort || parseInt(pi.getFlag("cdp-port") as string) || 9222;
	}

	function requireConnected(): number {
		if (!cdpPort) {
			throw new Error("Not connected to Chrome. Call browser_launch first.");
		}
		return cdpPort;
	}

	/**
	 * Resolve a profile flag value to a Chrome profile directory name.
	 * Accepts display name ("Work"), directory name ("Profile 3"), or email.
	 */
	function resolveProfile(input: string | undefined): string | undefined {
		if (!input) return undefined;

		const profiles = discoverProfiles();
		// Exact dir name match
		const byDir = profiles.find(p => p.dirName === input);
		if (byDir) return byDir.dirName;

		// Display name match (case-insensitive)
		const byName = profiles.find(p => p.displayName.toLowerCase() === input.toLowerCase());
		if (byName) return byName.dirName;

		// Email match
		const byEmail = profiles.find(p => p.email?.toLowerCase() === input.toLowerCase());
		if (byEmail) return byEmail.dirName;

		// Partial match
		const partial = profiles.find(p =>
			p.displayName.toLowerCase().includes(input.toLowerCase()) ||
			(p.email && p.email.toLowerCase().includes(input.toLowerCase()))
		);
		if (partial) return partial.dirName;

		return input; // Pass through as-is, Chrome will handle it
	}

	function formatResult(result: { stdout: string; stderr: string; exitCode: number; json?: any }): string {
		if (result.json) {
			return typeof result.json === "string" ? result.json : JSON.stringify(result.json, null, 2);
		}
		const output = result.stdout.trim() || result.stderr.trim();
		if (result.exitCode !== 0 && result.stderr) {
			return `Error (exit ${result.exitCode}): ${result.stderr.trim()}`;
		}
		return output || "(no output)";
	}

	// ─── browser_launch ─────────────────────────────────────────────────

	pi.registerTool({
		name: "browser_launch",
		label: "Browser Launch",
		description: `Connect to the user's Chrome browser via CDP. Uses their real profile with all logged-in sessions.

If Chrome is running without CDP: gracefully restarts it with debug port (all tabs restore).
If Chrome isn't running: launches it with the specified profile.

Set a profile by display name ("Work"), directory name ("Profile 1"), or email.`,
		parameters: Type.Object({
			profile: Type.Optional(Type.String({
				description: 'Chrome profile to use — display name ("Work"), dir name ("Profile 1"), or email. Omit for default profile.',
			})),
			port: Type.Optional(Type.Number({ description: "CDP port (default: 9222)" })),
		}),
		async execute(_id, params) {
			const { profile, port: portOverride } = params as { profile?: string; port?: number };

			// Check agent-browser is available
			if (!isInstalled()) {
				return {
					content: [{
						type: "text",
						text: "agent-browser not found. Install it:\n  npm install -g agent-browser && agent-browser install",
					}],
				};
			}

			const port = portOverride || getPort();
			const profileFlag = profile || (pi.getFlag("chrome-profile") as string) || undefined;
			const profileDir = resolveProfile(profileFlag);
			const chromePath = (pi.getFlag("chrome-path") as string) || undefined;

			// Detect current state
			const info = await detectChrome(port);

			let statusMsg = "";

			if (info.debugPortOpen) {
				// Already connected
				cdpPort = port;
				const cdpInfo = await getCdpInfo(port);
				statusMsg = `Connected to existing Chrome (CDP port ${port}).`;
				if (cdpInfo) statusMsg += `\nBrowser: ${cdpInfo.browser}`;
			} else {
				// Need to start or restart
				const result = await ensureChromeWithCdp({
					port,
					profileDirName: profileDir,
					binary: chromePath,
				});
				cdpPort = result.port;

				if (result.restarted) {
					statusMsg = `Restarted Chrome with CDP enabled (port ${port}). All tabs restored via session restore.`;
				} else if (result.launched) {
					statusMsg = `Launched Chrome with CDP enabled (port ${port}).`;
				}
			}

			// Connect agent-browser to the CDP port
			const connectResult = await runDirect(["connect", String(port)], { timeout: 10 });
			if (connectResult.exitCode !== 0 && connectResult.stderr.trim()) {
				statusMsg += `\nNote: ${connectResult.stderr.trim()}`;
			}

			connectedProfile = profileDir || "Default";
			statusMsg += `\nProfile: ${connectedProfile}`;

			// Show available profiles
			if (info.profiles.length > 1) {
				const profileList = info.profiles
					.map(p => `  ${p.dirName === connectedProfile ? "→" : " "} ${p.displayName}${p.email ? ` (${p.email})` : ""} [${p.dirName}]`)
					.join("\n");
				statusMsg += `\n\nAvailable profiles:\n${profileList}`;
				statusMsg += `\n\nSwitch profile: browser_launch with profile="<name>"`;
			}

			return { content: [{ type: "text", text: statusMsg }] };
		},
	});

	// ─── browser_go ─────────────────────────────────────────────────────

	pi.registerTool({
		name: "browser_go",
		label: "Browser Navigate",
		description: "Navigate to a URL in the connected Chrome browser.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to navigate to" }),
		}),
		async execute(_id, params) {
			const port = requireConnected();
			const { url } = params as { url: string };
			const result = await run(["open", url], port, { timeout: 30 });
			if (result.exitCode !== 0) {
				throw new Error(formatResult(result));
			}
			// Get page info after navigation
			const titleResult = await run(["get", "title"], port);
			const urlResult = await run(["get", "url"], port);
			const title = titleResult.stdout.trim() || titleResult.json?.title || "";
			const currentUrl = urlResult.stdout.trim() || urlResult.json?.url || url;
			return {
				content: [{ type: "text", text: `Navigated to: ${currentUrl}\nTitle: ${title}` }],
			};
		},
	});

	// ─── browser_snapshot ───────────────────────────────────────────────

	pi.registerTool({
		name: "browser_snapshot",
		label: "Browser Snapshot",
		description: `Get accessibility tree of the current page with element refs. This is the primary way to "see" the page.

Returns a tree like:
  - heading "Example" [ref=e1]
  - button "Submit" [ref=e2]
  - textbox "Email" [ref=e3]

Use refs with browser_click, browser_fill, etc: browser_click ref="@e2"`,
		parameters: Type.Object({
			interactive: Type.Optional(Type.Boolean({ description: "Only show interactive elements (buttons, inputs, links). Default: true" })),
			compact: Type.Optional(Type.Boolean({ description: "Remove empty structural elements. Default: true" })),
			selector: Type.Optional(Type.String({ description: "CSS selector to scope snapshot to a section of the page" })),
			depth: Type.Optional(Type.Number({ description: "Max tree depth" })),
		}),
		async execute(_id, params) {
			const port = requireConnected();
			const { interactive = true, compact = true, selector, depth } = params as any;

			const args = ["snapshot"];
			if (interactive) args.push("-i");
			if (compact) args.push("-c");
			if (selector) args.push("-s", selector);
			if (depth) args.push("-d", String(depth));

			// Snapshots are text, not JSON
			const result = await run(args, port, { json: false, timeout: 15 });
			if (result.exitCode !== 0) {
				throw new Error(formatResult(result));
			}

			let output = result.stdout.trim();
			// Truncate very large snapshots
			if (output.length > 50000) {
				output = output.slice(0, 50000) + "\n\n[Snapshot truncated. Use selector param to scope to a section.]";
			}

			return { content: [{ type: "text", text: output || "(empty page)" }] };
		},
	});

	// ─── browser_click ──────────────────────────────────────────────────

	pi.registerTool({
		name: "browser_click",
		label: "Browser Click",
		description: 'Click an element by ref (from snapshot) or CSS selector. Example: ref="@e2" or selector="#submit-btn"',
		parameters: Type.Object({
			ref: Type.Optional(Type.String({ description: 'Element ref from snapshot, e.g. "@e2"' })),
			selector: Type.Optional(Type.String({ description: "CSS selector" })),
		}),
		async execute(_id, params) {
			const port = requireConnected();
			const { ref, selector } = params as { ref?: string; selector?: string };
			const target = ref || selector;
			if (!target) throw new Error("Provide either ref or selector.");

			const result = await run(["click", target], port);
			if (result.exitCode !== 0) throw new Error(formatResult(result));
			return { content: [{ type: "text", text: `Clicked: ${target}` }] };
		},
	});

	// ─── browser_type ───────────────────────────────────────────────────

	pi.registerTool({
		name: "browser_type",
		label: "Browser Type",
		description: "Type text into an element (appends to existing content). Use browser_fill to clear first.",
		parameters: Type.Object({
			ref: Type.Optional(Type.String({ description: 'Element ref, e.g. "@e3"' })),
			selector: Type.Optional(Type.String({ description: "CSS selector" })),
			text: Type.String({ description: "Text to type" }),
		}),
		async execute(_id, params) {
			const port = requireConnected();
			const { ref, selector, text } = params as { ref?: string; selector?: string; text: string };
			const target = ref || selector;
			if (!target) throw new Error("Provide either ref or selector.");

			const result = await run(["type", target, text], port);
			if (result.exitCode !== 0) throw new Error(formatResult(result));
			return { content: [{ type: "text", text: `Typed "${text}" into ${target}` }] };
		},
	});

	// ─── browser_fill ───────────────────────────────────────────────────

	pi.registerTool({
		name: "browser_fill",
		label: "Browser Fill",
		description: "Clear an input and fill it with new text.",
		parameters: Type.Object({
			ref: Type.Optional(Type.String({ description: 'Element ref, e.g. "@e3"' })),
			selector: Type.Optional(Type.String({ description: "CSS selector" })),
			text: Type.String({ description: "Text to fill" }),
		}),
		async execute(_id, params) {
			const port = requireConnected();
			const { ref, selector, text } = params as { ref?: string; selector?: string; text: string };
			const target = ref || selector;
			if (!target) throw new Error("Provide either ref or selector.");

			const result = await run(["fill", target, text], port);
			if (result.exitCode !== 0) throw new Error(formatResult(result));
			return { content: [{ type: "text", text: `Filled ${target} with "${text}"` }] };
		},
	});

	// ─── browser_screenshot ─────────────────────────────────────────────

	pi.registerTool({
		name: "browser_screenshot",
		label: "Browser Screenshot",
		description: "Take a screenshot of the current page. Returns the file path to the saved image.",
		parameters: Type.Object({
			fullPage: Type.Optional(Type.Boolean({ description: "Capture full page (not just viewport). Default: false" })),
			path: Type.Optional(Type.String({ description: "Save path (default: temp file)" })),
		}),
		async execute(_id, params) {
			const port = requireConnected();
			const { fullPage, path } = params as { fullPage?: boolean; path?: string };

			const savePath = path || screenshotPath();
			const args = ["screenshot", savePath];
			if (fullPage) args.push("--full");

			const result = await run(args, port, { json: false });
			if (result.exitCode !== 0) throw new Error(formatResult(result));
			return { content: [{ type: "text", text: `Screenshot saved: ${savePath}` }] };
		},
	});

	// ─── browser_read ───────────────────────────────────────────────────

	pi.registerTool({
		name: "browser_read",
		label: "Browser Read",
		description: "Read content from the page — text, HTML, input value, attribute, title, or URL.",
		parameters: Type.Object({
			what: Type.Union([
				Type.Literal("text"),
				Type.Literal("html"),
				Type.Literal("value"),
				Type.Literal("title"),
				Type.Literal("url"),
			], { description: "What to read" }),
			ref: Type.Optional(Type.String({ description: 'Element ref for text/html/value' })),
			selector: Type.Optional(Type.String({ description: "CSS selector for text/html/value" })),
			attr: Type.Optional(Type.String({ description: "Attribute name (use what='text' as type placeholder)" })),
		}),
		async execute(_id, params) {
			const port = requireConnected();
			const { what, ref, selector, attr } = params as any;
			const target = ref || selector;

			let args: string[];
			if (what === "title") {
				args = ["get", "title"];
			} else if (what === "url") {
				args = ["get", "url"];
			} else if (attr && target) {
				args = ["get", "attr", target, attr];
			} else if (target) {
				args = ["get", what, target];
			} else {
				throw new Error("Provide ref or selector for text/html/value reads.");
			}

			const result = await run(args, port, { json: false });
			if (result.exitCode !== 0) throw new Error(formatResult(result));

			let output = result.stdout.trim();
			if (output.length > 50000) {
				output = output.slice(0, 50000) + "\n\n[Truncated at 50KB]";
			}
			return { content: [{ type: "text", text: output || "(empty)" }] };
		},
	});

	// ─── browser_tabs ───────────────────────────────────────────────────

	pi.registerTool({
		name: "browser_tabs",
		label: "Browser Tabs",
		description: "List open tabs or switch to a tab by index.",
		parameters: Type.Object({
			switchTo: Type.Optional(Type.Number({ description: "Tab index to switch to (from tab list)" })),
		}),
		async execute(_id, params) {
			const port = requireConnected();
			const { switchTo } = params as { switchTo?: number };

			if (switchTo !== undefined) {
				const result = await run(["tab", String(switchTo)], port, { json: false });
				if (result.exitCode !== 0) throw new Error(formatResult(result));
				return { content: [{ type: "text", text: `Switched to tab ${switchTo}` }] };
			}

			const result = await run(["tab"], port, { json: false });
			if (result.exitCode !== 0) throw new Error(formatResult(result));
			return { content: [{ type: "text", text: result.stdout.trim() || "(no tabs)" }] };
		},
	});

	// ─── browser_wait ───────────────────────────────────────────────────

	pi.registerTool({
		name: "browser_wait",
		label: "Browser Wait",
		description: "Wait for an element, text, URL pattern, or load state.",
		parameters: Type.Object({
			selector: Type.Optional(Type.String({ description: "CSS selector to wait for" })),
			text: Type.Optional(Type.String({ description: "Text to wait for" })),
			url: Type.Optional(Type.String({ description: "URL pattern to wait for (glob)" })),
			load: Type.Optional(Type.String({ description: "Load state: load, domcontentloaded, networkidle" })),
			ms: Type.Optional(Type.Number({ description: "Milliseconds to wait" })),
		}),
		async execute(_id, params) {
			const port = requireConnected();
			const { selector, text, url, load, ms } = params as any;

			let args: string[];
			if (selector) {
				args = ["wait", selector];
			} else if (text) {
				args = ["wait", "--text", text];
			} else if (url) {
				args = ["wait", "--url", url];
			} else if (load) {
				args = ["wait", "--load", load];
			} else if (ms) {
				args = ["wait", String(ms)];
			} else {
				throw new Error("Provide selector, text, url, load, or ms.");
			}

			const result = await run(args, port, { timeout: 60 });
			if (result.exitCode !== 0) throw new Error(formatResult(result));
			return { content: [{ type: "text", text: "Wait completed." }] };
		},
	});

	// ─── browser_eval ───────────────────────────────────────────────────

	pi.registerTool({
		name: "browser_eval",
		label: "Browser Eval",
		description: "Execute JavaScript in the page context. Returns the result.",
		parameters: Type.Object({
			js: Type.String({ description: "JavaScript to execute" }),
		}),
		async execute(_id, params) {
			const port = requireConnected();
			const { js } = params as { js: string };

			const result = await run(["eval", js], port, { json: false });
			if (result.exitCode !== 0) throw new Error(formatResult(result));

			let output = result.stdout.trim();
			if (output.length > 50000) {
				output = output.slice(0, 50000) + "\n[Truncated]";
			}
			return { content: [{ type: "text", text: output || "undefined" }] };
		},
	});

	// ─── browser_scroll ─────────────────────────────────────────────────

	pi.registerTool({
		name: "browser_scroll",
		label: "Browser Scroll",
		description: "Scroll the page in a direction.",
		parameters: Type.Object({
			direction: Type.Union([
				Type.Literal("up"),
				Type.Literal("down"),
				Type.Literal("left"),
				Type.Literal("right"),
			], { description: "Scroll direction" }),
			pixels: Type.Optional(Type.Number({ description: "Pixels to scroll (default: viewport height)" })),
		}),
		async execute(_id, params) {
			const port = requireConnected();
			const { direction, pixels } = params as { direction: string; pixels?: number };

			const args = ["scroll", direction];
			if (pixels) args.push(String(pixels));

			const result = await run(args, port);
			if (result.exitCode !== 0) throw new Error(formatResult(result));
			return { content: [{ type: "text", text: `Scrolled ${direction}${pixels ? ` ${pixels}px` : ""}` }] };
		},
	});

	// ─── browser_find ───────────────────────────────────────────────────

	pi.registerTool({
		name: "browser_find",
		label: "Browser Find",
		description: 'Find elements semantically by role, text, label, placeholder, etc. and perform an action. Example: type="role" value="button" action="click" name="Submit"',
		parameters: Type.Object({
			type: Type.Union([
				Type.Literal("role"),
				Type.Literal("text"),
				Type.Literal("label"),
				Type.Literal("placeholder"),
				Type.Literal("alt"),
				Type.Literal("title"),
				Type.Literal("testid"),
			], { description: "Locator type" }),
			value: Type.String({ description: "Value to find" }),
			action: Type.Union([
				Type.Literal("click"),
				Type.Literal("fill"),
				Type.Literal("check"),
				Type.Literal("hover"),
				Type.Literal("text"),
			], { description: "Action to perform" }),
			name: Type.Optional(Type.String({ description: "Accessible name filter (for role locators)" })),
			fillText: Type.Optional(Type.String({ description: "Text to fill (when action is 'fill')" })),
		}),
		async execute(_id, params) {
			const port = requireConnected();
			const { type, value, action, name, fillText } = params as any;

			const args = ["find", type, value, action];
			if (fillText) args.push(fillText);
			if (name) args.push("--name", name);

			const result = await run(args, port, { json: false });
			if (result.exitCode !== 0) throw new Error(formatResult(result));
			return { content: [{ type: "text", text: result.stdout.trim() || `find ${type}=${value} ${action} done` }] };
		},
	});

	// ─── browser_press ──────────────────────────────────────────────────

	pi.registerTool({
		name: "browser_press",
		label: "Browser Press Key",
		description: "Press a keyboard key. Examples: Enter, Tab, Escape, Control+a, ArrowDown",
		parameters: Type.Object({
			key: Type.String({ description: "Key to press (e.g. Enter, Tab, Escape, Control+a)" }),
		}),
		async execute(_id, params) {
			const port = requireConnected();
			const { key } = params as { key: string };

			const result = await run(["press", key], port);
			if (result.exitCode !== 0) throw new Error(formatResult(result));
			return { content: [{ type: "text", text: `Pressed: ${key}` }] };
		},
	});

	// ─── browser_close ──────────────────────────────────────────────────

	pi.registerTool({
		name: "browser_close",
		label: "Browser Disconnect",
		description: "Disconnect from Chrome. The browser stays open with all tabs.",
		parameters: Type.Object({}),
		async execute() {
			if (cdpPort) {
				await run(["close"], cdpPort).catch(() => { });
			}
			cdpPort = null;
			connectedProfile = null;
			return { content: [{ type: "text", text: "Disconnected from Chrome. Browser remains open." }] };
		},
	});

	// ─── /browser command ───────────────────────────────────────────────

	pi.registerCommand("browser", {
		description: "Browser dashboard — connect, list profiles, manage connection",
		handler: async (_args, ctx) => {
			const info = await detectChrome();
			const status = cdpPort
				? `Connected (CDP port ${cdpPort}, profile: ${connectedProfile || "Default"})`
				: "Not connected";

			const lines = [
				`Status: ${status}`,
				`Chrome: ${info.running ? "running" : "not running"}`,
				`CDP port ${info.cdpPort}: ${info.debugPortOpen ? "open" : "closed"}`,
				`Binary: ${info.binary || "not found"}`,
				`Profiles (${info.profiles.length}):`,
				...info.profiles.map(p =>
					`  ${p.dirName === connectedProfile ? "→" : " "} ${p.displayName}${p.email ? ` (${p.email})` : ""} [${p.dirName}]`
				),
			];

			if (!cdpPort) {
				const options = [
					"Connect (default profile)",
					...info.profiles.map(p => `Connect as: ${p.displayName}${p.email ? ` (${p.email})` : ""}`),
					"Cancel",
				];

				const selected = await ctx.ui.select("Browser Connect", options);
				if (!selected || selected === "Cancel") return;

				if (selected === "Connect (default profile)") {
					ctx.ui.notify("Connecting to Chrome...", "info");
				} else {
					const profileName = selected.replace("Connect as: ", "").replace(/ \(.*\)$/, "");
					ctx.ui.notify(`Connecting as ${profileName}...`, "info");
				}
			} else {
				ctx.ui.notify(lines.join("\n"), "info");
			}
		},
	});

	// ─── Status on startup ──────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const installed = isInstalled();
		if (!installed) {
			ctx.ui.setStatus("browser", "browser: agent-browser not installed");
			return;
		}

		const portOpen = await isDebugPortOpen();
		if (portOpen) {
			ctx.ui.setStatus("browser", "browser: Chrome CDP ready");
		} else {
			ctx.ui.setStatus("browser", "browser: ready");
		}
	});
}
