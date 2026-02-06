/**
 * Tests for individual browser tools post-connection, resolveProfile,
 * formatResult, session_start event, and edge cases.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("../chrome.js", () => ({
	detectChrome: vi.fn(),
	ensureChromeWithCdp: vi.fn(),
	discoverProfiles: vi.fn().mockReturnValue([]),
	isDebugPortOpen: vi.fn().mockResolvedValue(false),
	getCdpInfo: vi.fn().mockResolvedValue(null),
	launchIsolatedBrowser: vi.fn(),
}));

vi.mock("../agent-browser.js", () => ({
	run: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
	runDirect: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
	screenshotPath: vi.fn().mockReturnValue("/tmp/screenshot.png"),
	isInstalled: vi.fn().mockReturnValue(true),
	install: vi.fn(),
}));

import {
	detectChrome,
	ensureChromeWithCdp,
	getCdpInfo,
	discoverProfiles,
	isDebugPortOpen,
} from "../chrome.js";
import { run, runDirect, isInstalled } from "../agent-browser.js";

// ─── Test Helpers ───────────────────────────────────────────────────────────

interface RegisteredTool {
	name: string;
	execute: (...args: any[]) => Promise<any>;
}

function createMockPI() {
	const tools = new Map<string, RegisteredTool>();
	const flags = new Map<string, any>();
	const listeners = new Map<string, Function>();

	return {
		tools,
		flags,
		listeners,
		registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
		registerFlag(name: string, opts: any) { flags.set(name, opts.default); },
		registerCommand(_name: string, _handler: any) {},
		getFlag(name: string) { return flags.get(name); },
		on(event: string, handler: Function) { listeners.set(event, handler); },
	};
}

function createMockCtx() {
	return {
		ui: {
			confirm: vi.fn().mockResolvedValue(true),
			select: vi.fn(),
			notify: vi.fn(),
			setStatus: vi.fn(),
		},
	};
}

/** Connect the mock extension so tools can be used */
async function setupConnected(mockPI: ReturnType<typeof createMockPI>) {
	vi.mocked(isInstalled).mockReturnValue(true);
	vi.mocked(detectChrome).mockResolvedValue({
		binary: "/usr/bin/chrome",
		userDataDir: "/tmp/chrome",
		profiles: [],
		running: false,
		debugPortOpen: true, // already open
		cdpPort: 9222,
	});
	vi.mocked(getCdpInfo).mockResolvedValue({ browser: "Chrome/120", wsUrl: "ws://localhost:9222" });

	const tool = mockPI.tools.get("browser_launch")!;
	await tool.execute("id", {}, undefined, undefined, createMockCtx());
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("resolveProfile", () => {
	let mockPI: ReturnType<typeof createMockPI>;

	beforeEach(async () => {
		vi.clearAllMocks();
		mockPI = createMockPI();

		vi.mocked(discoverProfiles).mockReturnValue([
			{ dirName: "Default", displayName: "Personal", path: "/tmp/Default", email: "me@example.com" },
			{ dirName: "Profile 1", displayName: "Work", path: "/tmp/Profile 1", email: "work@company.com" },
			{ dirName: "Profile 2", displayName: "Side Project", path: "/tmp/Profile 2" },
		]);

		const { default: ext } = await import("../index.js");
		ext(mockPI as any);
	});

	// resolveProfile is internal, but we can test it through browser_launch
	// by checking what profileDirName gets passed to ensureChromeWithCdp

	it("resolves by exact directory name", async () => {
		vi.mocked(isInstalled).mockReturnValue(true);
		vi.mocked(detectChrome).mockResolvedValue({
			binary: "/usr/bin/chrome", userDataDir: "/tmp", profiles: [],
			running: false, debugPortOpen: false, cdpPort: 9222,
		});
		vi.mocked(ensureChromeWithCdp).mockResolvedValue({ port: 9222, restarted: false, launched: true });

		const tool = mockPI.tools.get("browser_launch")!;
		await tool.execute("id", { profile: "Profile 1" }, undefined, undefined, createMockCtx());

		// Chrome not running → direct launch, profile gets passed through
		const call = vi.mocked(ensureChromeWithCdp).mock.calls[0][0];
		expect(call.profileDirName).toBe("Profile 1");
	});

	it("resolves by display name (case-insensitive)", async () => {
		vi.mocked(isInstalled).mockReturnValue(true);
		vi.mocked(detectChrome).mockResolvedValue({
			binary: "/usr/bin/chrome", userDataDir: "/tmp", profiles: [],
			running: false, debugPortOpen: false, cdpPort: 9222,
		});
		vi.mocked(ensureChromeWithCdp).mockResolvedValue({ port: 9222, restarted: false, launched: true });

		const tool = mockPI.tools.get("browser_launch")!;
		await tool.execute("id", { profile: "work" }, undefined, undefined, createMockCtx());

		const call = vi.mocked(ensureChromeWithCdp).mock.calls[0][0];
		expect(call.profileDirName).toBe("Profile 1");
	});

	it("resolves by email", async () => {
		vi.mocked(isInstalled).mockReturnValue(true);
		vi.mocked(detectChrome).mockResolvedValue({
			binary: "/usr/bin/chrome", userDataDir: "/tmp", profiles: [],
			running: false, debugPortOpen: false, cdpPort: 9222,
		});
		vi.mocked(ensureChromeWithCdp).mockResolvedValue({ port: 9222, restarted: false, launched: true });

		const tool = mockPI.tools.get("browser_launch")!;
		await tool.execute("id", { profile: "work@company.com" }, undefined, undefined, createMockCtx());

		const call = vi.mocked(ensureChromeWithCdp).mock.calls[0][0];
		expect(call.profileDirName).toBe("Profile 1");
	});

	it("resolves by partial match", async () => {
		vi.mocked(isInstalled).mockReturnValue(true);
		vi.mocked(detectChrome).mockResolvedValue({
			binary: "/usr/bin/chrome", userDataDir: "/tmp", profiles: [],
			running: false, debugPortOpen: false, cdpPort: 9222,
		});
		vi.mocked(ensureChromeWithCdp).mockResolvedValue({ port: 9222, restarted: false, launched: true });

		const tool = mockPI.tools.get("browser_launch")!;
		await tool.execute("id", { profile: "Side" }, undefined, undefined, createMockCtx());

		const call = vi.mocked(ensureChromeWithCdp).mock.calls[0][0];
		expect(call.profileDirName).toBe("Profile 2");
	});

	it("passes through unknown profile name as-is", async () => {
		vi.mocked(isInstalled).mockReturnValue(true);
		vi.mocked(detectChrome).mockResolvedValue({
			binary: "/usr/bin/chrome", userDataDir: "/tmp", profiles: [],
			running: false, debugPortOpen: false, cdpPort: 9222,
		});
		vi.mocked(ensureChromeWithCdp).mockResolvedValue({ port: 9222, restarted: false, launched: true });

		const tool = mockPI.tools.get("browser_launch")!;
		await tool.execute("id", { profile: "SomeUnknownProfile" }, undefined, undefined, createMockCtx());

		const call = vi.mocked(ensureChromeWithCdp).mock.calls[0][0];
		expect(call.profileDirName).toBe("SomeUnknownProfile");
	});
});

describe("browser tools post-connection", () => {
	let mockPI: ReturnType<typeof createMockPI>;

	beforeEach(async () => {
		vi.clearAllMocks();
		mockPI = createMockPI();
		const { default: ext } = await import("../index.js");
		ext(mockPI as any);
		await setupConnected(mockPI);
	});

	describe("browser_go", () => {
		it("calls run with open command and URL", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_go")!;
			const result = await tool.execute("id", { url: "https://example.com" }, undefined, undefined, createMockCtx());

			expect(vi.mocked(run)).toHaveBeenCalledWith(
				["open", "https://example.com"],
				9222,
				{ timeout: 30 },
			);
			expect(result.content[0].text).toContain("Navigated to");
		});

		it("throws on non-zero exit code", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "", stderr: "connection refused", exitCode: 1 });

			const tool = mockPI.tools.get("browser_go")!;
			await expect(tool.execute("id", { url: "https://example.com" }, undefined, undefined, createMockCtx()))
				.rejects.toThrow("connection refused");
		});
	});

	describe("browser_snapshot", () => {
		it("calls run with snapshot and interactive/compact flags by default", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "- heading \"Hello\" [ref=e1]", stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_snapshot")!;
			const result = await tool.execute("id", {}, undefined, undefined, createMockCtx());

			const [args] = vi.mocked(run).mock.calls[0];
			expect(args).toContain("snapshot");
			expect(args).toContain("-i"); // interactive
			expect(args).toContain("-c"); // compact
			expect(result.content[0].text).toContain("heading");
		});

		it("passes selector and depth when provided", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "tree", stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_snapshot")!;
			await tool.execute("id", { selector: "#main", depth: 3 }, undefined, undefined, createMockCtx());

			const [args] = vi.mocked(run).mock.calls[0];
			expect(args).toContain("-s");
			expect(args).toContain("#main");
			expect(args).toContain("-d");
			expect(args).toContain("3");
		});

		it("truncates output over 50KB", async () => {
			const longOutput = "x".repeat(60000);
			vi.mocked(run).mockResolvedValue({ stdout: longOutput, stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_snapshot")!;
			const result = await tool.execute("id", {}, undefined, undefined, createMockCtx());

			expect(result.content[0].text.length).toBeLessThan(55000);
			expect(result.content[0].text).toContain("[Snapshot truncated");
		});
	});

	describe("browser_click", () => {
		it("passes ref to run command", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_click")!;
			await tool.execute("id", { ref: "@e2" }, undefined, undefined, createMockCtx());

			expect(vi.mocked(run)).toHaveBeenCalledWith(["click", "@e2"], 9222);
		});

		it("passes selector to run command", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_click")!;
			await tool.execute("id", { selector: "#btn" }, undefined, undefined, createMockCtx());

			expect(vi.mocked(run)).toHaveBeenCalledWith(["click", "#btn"], 9222);
		});

		it("throws when neither ref nor selector provided", async () => {
			const tool = mockPI.tools.get("browser_click")!;
			await expect(tool.execute("id", {}, undefined, undefined, createMockCtx()))
				.rejects.toThrow("Provide either ref or selector");
		});
	});

	describe("browser_type", () => {
		it("passes ref and text to run command", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_type")!;
			await tool.execute("id", { ref: "@e3", text: "hello" }, undefined, undefined, createMockCtx());

			expect(vi.mocked(run)).toHaveBeenCalledWith(["type", "@e3", "hello"], 9222);
		});
	});

	describe("browser_fill", () => {
		it("passes ref and text to run command", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_fill")!;
			await tool.execute("id", { ref: "@e3", text: "new value" }, undefined, undefined, createMockCtx());

			expect(vi.mocked(run)).toHaveBeenCalledWith(["fill", "@e3", "new value"], 9222);
		});
	});

	describe("browser_eval", () => {
		it("passes JS expression to run command", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "42", stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_eval")!;
			const result = await tool.execute("id", { js: "1 + 1" }, undefined, undefined, createMockCtx());

			expect(vi.mocked(run)).toHaveBeenCalledWith(
				["eval", "1 + 1"], 9222, { json: false },
			);
			expect(result.content[0].text).toBe("42");
		});

		it("returns 'undefined' for empty output", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_eval")!;
			const result = await tool.execute("id", { js: "void 0" }, undefined, undefined, createMockCtx());

			expect(result.content[0].text).toBe("undefined");
		});

		it("truncates large output", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "x".repeat(60000), stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_eval")!;
			const result = await tool.execute("id", { js: "bigData" }, undefined, undefined, createMockCtx());

			expect(result.content[0].text).toContain("[Truncated]");
		});
	});

	describe("browser_scroll", () => {
		it("passes direction to run command", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_scroll")!;
			await tool.execute("id", { direction: "down" }, undefined, undefined, createMockCtx());

			expect(vi.mocked(run)).toHaveBeenCalledWith(["scroll", "down"], 9222);
		});

		it("includes pixel count when specified", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_scroll")!;
			await tool.execute("id", { direction: "up", pixels: 500 }, undefined, undefined, createMockCtx());

			expect(vi.mocked(run)).toHaveBeenCalledWith(["scroll", "up", "500"], 9222);
		});
	});

	describe("browser_press", () => {
		it("passes key to run command", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_press")!;
			const result = await tool.execute("id", { key: "Enter" }, undefined, undefined, createMockCtx());

			expect(vi.mocked(run)).toHaveBeenCalledWith(["press", "Enter"], 9222);
			expect(result.content[0].text).toContain("Pressed: Enter");
		});
	});

	describe("browser_tabs", () => {
		it("lists tabs when no switchTo provided", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "0: Google - https://google.com", stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_tabs")!;
			const result = await tool.execute("id", {}, undefined, undefined, createMockCtx());

			expect(vi.mocked(run)).toHaveBeenCalledWith(["tab"], 9222, { json: false });
			expect(result.content[0].text).toContain("Google");
		});

		it("switches tab when switchTo provided", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_tabs")!;
			const result = await tool.execute("id", { switchTo: 2 }, undefined, undefined, createMockCtx());

			expect(vi.mocked(run)).toHaveBeenCalledWith(["tab", "2"], 9222, { json: false });
			expect(result.content[0].text).toContain("Switched to tab 2");
		});
	});

	describe("browser_wait", () => {
		it("waits for CSS selector", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_wait")!;
			await tool.execute("id", { selector: "#loaded" }, undefined, undefined, createMockCtx());

			expect(vi.mocked(run)).toHaveBeenCalledWith(["wait", "#loaded"], 9222, { timeout: 60 });
		});

		it("waits for text", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_wait")!;
			await tool.execute("id", { text: "Welcome" }, undefined, undefined, createMockCtx());

			const [args] = vi.mocked(run).mock.calls[0];
			expect(args).toEqual(["wait", "--text", "Welcome"]);
		});

		it("waits for URL pattern", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_wait")!;
			await tool.execute("id", { url: "**/dashboard" }, undefined, undefined, createMockCtx());

			const [args] = vi.mocked(run).mock.calls[0];
			expect(args).toEqual(["wait", "--url", "**/dashboard"]);
		});

		it("waits for load state", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_wait")!;
			await tool.execute("id", { load: "networkidle" }, undefined, undefined, createMockCtx());

			const [args] = vi.mocked(run).mock.calls[0];
			expect(args).toEqual(["wait", "--load", "networkidle"]);
		});

		it("waits fixed ms", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_wait")!;
			await tool.execute("id", { ms: 2000 }, undefined, undefined, createMockCtx());

			const [args] = vi.mocked(run).mock.calls[0];
			expect(args).toEqual(["wait", "2000"]);
		});

		it("throws when no wait criteria provided", async () => {
			const tool = mockPI.tools.get("browser_wait")!;
			await expect(tool.execute("id", {}, undefined, undefined, createMockCtx()))
				.rejects.toThrow("Provide selector, text, url, load, or ms");
		});
	});

	describe("browser_read", () => {
		it("reads title", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "My Page", stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_read")!;
			const result = await tool.execute("id", { what: "title" }, undefined, undefined, createMockCtx());

			expect(vi.mocked(run)).toHaveBeenCalledWith(["get", "title"], 9222, { json: false });
			expect(result.content[0].text).toBe("My Page");
		});

		it("reads URL", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "https://example.com", stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_read")!;
			const result = await tool.execute("id", { what: "url" }, undefined, undefined, createMockCtx());

			expect(vi.mocked(run)).toHaveBeenCalledWith(["get", "url"], 9222, { json: false });
		});

		it("reads text from element by ref", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "Hello World", stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_read")!;
			await tool.execute("id", { what: "text", ref: "@e1" }, undefined, undefined, createMockCtx());

			expect(vi.mocked(run)).toHaveBeenCalledWith(["get", "text", "@e1"], 9222, { json: false });
		});

		it("reads attribute from element", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "/path/to/image.png", stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_read")!;
			await tool.execute("id", { what: "text", selector: "img", attr: "src" }, undefined, undefined, createMockCtx());

			expect(vi.mocked(run)).toHaveBeenCalledWith(["get", "attr", "img", "src"], 9222, { json: false });
		});

		it("throws when no target provided for text/html/value", async () => {
			const tool = mockPI.tools.get("browser_read")!;
			await expect(tool.execute("id", { what: "text" }, undefined, undefined, createMockCtx()))
				.rejects.toThrow("Provide ref or selector");
		});
	});

	describe("browser_screenshot", () => {
		it("calls run with screenshot command", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_screenshot")!;
			const result = await tool.execute("id", {}, undefined, undefined, createMockCtx());

			expect(vi.mocked(run)).toHaveBeenCalledWith(
				["screenshot", "/tmp/screenshot.png"],
				9222,
				{ json: false },
			);
			expect(result.content[0].text).toContain("Screenshot saved");
		});

		it("includes --full flag for full page", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_screenshot")!;
			await tool.execute("id", { fullPage: true }, undefined, undefined, createMockCtx());

			const [args] = vi.mocked(run).mock.calls[0];
			expect(args).toContain("--full");
		});

		it("uses custom save path", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_screenshot")!;
			await tool.execute("id", { path: "/custom/path.png" }, undefined, undefined, createMockCtx());

			const [args] = vi.mocked(run).mock.calls[0];
			expect(args).toContain("/custom/path.png");
		});
	});

	describe("browser_find", () => {
		it("passes locator type, value, and action", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_find")!;
			await tool.execute("id", {
				type: "role",
				value: "button",
				action: "click",
			}, undefined, undefined, createMockCtx());

			expect(vi.mocked(run)).toHaveBeenCalledWith(
				["find", "role", "button", "click"],
				9222,
				{ json: false },
			);
		});

		it("includes fillText and name when provided", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_find")!;
			await tool.execute("id", {
				type: "role",
				value: "textbox",
				action: "fill",
				fillText: "hello",
				name: "Email",
			}, undefined, undefined, createMockCtx());

			const [args] = vi.mocked(run).mock.calls[0];
			expect(args).toEqual(["find", "role", "textbox", "fill", "hello", "--name", "Email"]);
		});
	});

	describe("browser_close", () => {
		it("calls run with close and resets connection state", async () => {
			vi.mocked(run).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

			const tool = mockPI.tools.get("browser_close")!;
			const result = await tool.execute("id", {}, undefined, undefined, createMockCtx());

			expect(result.content[0].text).toContain("Disconnected");

			// After close, other tools should throw
			const goTool = mockPI.tools.get("browser_go")!;
			await expect(goTool.execute("id", { url: "https://example.com" }, undefined, undefined, createMockCtx()))
				.rejects.toThrow("Not connected");
		});
	});
});

describe("session_start event", () => {
	it("sets status when agent-browser is installed and CDP not open", async () => {
		vi.clearAllMocks();
		const mockPI = createMockPI();
		vi.mocked(isInstalled).mockReturnValue(true);
		vi.mocked(isDebugPortOpen).mockResolvedValue(false);

		const { default: ext } = await import("../index.js");
		ext(mockPI as any);

		const handler = mockPI.listeners.get("session_start");
		expect(handler).toBeDefined();

		const ctx = createMockCtx();
		await handler!({}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenCalledWith("browser", "browser: ready");
	});

	it("sets CDP ready status when port is already open", async () => {
		vi.clearAllMocks();
		const mockPI = createMockPI();
		vi.mocked(isInstalled).mockReturnValue(true);
		vi.mocked(isDebugPortOpen).mockResolvedValue(true);

		const { default: ext } = await import("../index.js");
		ext(mockPI as any);

		const handler = mockPI.listeners.get("session_start");
		const ctx = createMockCtx();
		await handler!({}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenCalledWith("browser", "browser: Chrome CDP ready");
	});

	it("sets not-installed status when agent-browser is missing", async () => {
		vi.clearAllMocks();
		const mockPI = createMockPI();
		vi.mocked(isInstalled).mockReturnValue(false);

		const { default: ext } = await import("../index.js");
		ext(mockPI as any);

		const handler = mockPI.listeners.get("session_start");
		const ctx = createMockCtx();
		await handler!({}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenCalledWith("browser", "browser: agent-browser not installed");
	});
});

describe("edge cases", () => {
	let mockPI: ReturnType<typeof createMockPI>;

	beforeEach(async () => {
		vi.clearAllMocks();
		mockPI = createMockPI();
		const { default: ext } = await import("../index.js");
		ext(mockPI as any);
	});

	it("uses flag values when no params provided", async () => {
		mockPI.flags.set("cdp-port", "9333");
		mockPI.flags.set("chrome-profile", "Work");

		vi.mocked(isInstalled).mockReturnValue(true);
		vi.mocked(discoverProfiles).mockReturnValue([
			{ dirName: "Profile 1", displayName: "Work", path: "/tmp/Profile 1" },
		]);
		vi.mocked(detectChrome).mockResolvedValue({
			binary: "/usr/bin/chrome", userDataDir: "/tmp", profiles: [],
			running: false, debugPortOpen: false, cdpPort: 9333,
		});
		vi.mocked(ensureChromeWithCdp).mockResolvedValue({ port: 9333, restarted: false, launched: true });

		const tool = mockPI.tools.get("browser_launch")!;
		await tool.execute("id", {}, undefined, undefined, createMockCtx());

		expect(vi.mocked(ensureChromeWithCdp)).toHaveBeenCalledWith(
			expect.objectContaining({ port: 9333, profileDirName: "Profile 1" }),
		);
	});

	it("param overrides flag values", async () => {
		mockPI.flags.set("cdp-port", "9333");

		vi.mocked(isInstalled).mockReturnValue(true);
		vi.mocked(detectChrome).mockResolvedValue({
			binary: "/usr/bin/chrome", userDataDir: "/tmp", profiles: [],
			running: false, debugPortOpen: false, cdpPort: 9444,
		});
		vi.mocked(ensureChromeWithCdp).mockResolvedValue({ port: 9444, restarted: false, launched: true });

		const tool = mockPI.tools.get("browser_launch")!;
		await tool.execute("id", { port: 9444 }, undefined, undefined, createMockCtx());

		expect(vi.mocked(ensureChromeWithCdp)).toHaveBeenCalledWith(
			expect.objectContaining({ port: 9444 }),
		);
	});

	it("shows profile list when multiple profiles exist", async () => {
		vi.mocked(isInstalled).mockReturnValue(true);
		vi.mocked(detectChrome).mockResolvedValue({
			binary: "/usr/bin/chrome", userDataDir: "/tmp",
			profiles: [
				{ dirName: "Default", displayName: "Personal", path: "/tmp/Default", email: "me@test.com" },
				{ dirName: "Profile 1", displayName: "Work", path: "/tmp/Profile 1" },
			],
			running: false, debugPortOpen: true, cdpPort: 9222,
		});
		vi.mocked(getCdpInfo).mockResolvedValue({ browser: "Chrome/120", wsUrl: "ws://localhost:9222" });

		const tool = mockPI.tools.get("browser_launch")!;
		const result = await tool.execute("id", {}, undefined, undefined, createMockCtx());

		expect(result.content[0].text).toContain("Available profiles");
		expect(result.content[0].text).toContain("Personal");
		expect(result.content[0].text).toContain("Work");
	});
});
