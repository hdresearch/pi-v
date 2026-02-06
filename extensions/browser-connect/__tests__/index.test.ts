/**
 * Tests for index.ts — extension tool registration and browser_launch orchestration.
 *
 * Uses a mock ExtensionAPI to capture registered tools and test their behavior
 * with mocked Chrome/CDP dependencies.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock Setup ─────────────────────────────────────────────────────────────

// Mock chrome.ts
vi.mock("../chrome.js", () => ({
	detectChrome: vi.fn(),
	ensureChromeWithCdp: vi.fn(),
	discoverProfiles: vi.fn().mockReturnValue([]),
	isDebugPortOpen: vi.fn().mockResolvedValue(false),
	getCdpInfo: vi.fn().mockResolvedValue(null),
	launchIsolatedBrowser: vi.fn(),
}));

// Mock agent-browser.ts
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
	launchIsolatedBrowser,
} from "../chrome.js";

import { runDirect, isInstalled } from "../agent-browser.js";

// ─── Fake ExtensionAPI ──────────────────────────────────────────────────────

interface RegisteredTool {
	name: string;
	label: string;
	description: string;
	parameters: any;
	execute: (...args: any[]) => Promise<any>;
}

function createMockPI() {
	const tools = new Map<string, RegisteredTool>();
	const flags = new Map<string, any>();
	const commands = new Map<string, any>();
	const listeners = new Map<string, Function>();

	return {
		tools,
		flags,
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		registerFlag(name: string, opts: any) {
			flags.set(name, opts.default);
		},
		registerCommand(name: string, handler: any) {
			commands.set(name, handler);
		},
		getFlag(name: string) {
			return flags.get(name);
		},
		on(event: string, handler: Function) {
			listeners.set(event, handler);
		},
	};
}

function createMockCtx(opts: { confirmResult?: boolean; selectResult?: string } = {}) {
	return {
		ui: {
			confirm: vi.fn().mockResolvedValue(opts.confirmResult ?? true),
			select: vi.fn().mockResolvedValue(opts.selectResult),
			notify: vi.fn(),
			setStatus: vi.fn(),
		},
	};
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("browserConnectExtension", () => {
	let mockPI: ReturnType<typeof createMockPI>;

	beforeEach(async () => {
		vi.clearAllMocks();
		mockPI = createMockPI();

		const { default: browserConnectExtension } = await import("../index.js");
		browserConnectExtension(mockPI as any);
	});

	describe("tool registration", () => {
		it("registers all expected tools", () => {
			const expectedTools = [
				"browser_launch",
				"browser_go",
				"browser_snapshot",
				"browser_click",
				"browser_type",
				"browser_fill",
				"browser_screenshot",
				"browser_read",
				"browser_tabs",
				"browser_wait",
				"browser_eval",
				"browser_scroll",
				"browser_find",
				"browser_press",
				"browser_close",
			];

			for (const name of expectedTools) {
				expect(mockPI.tools.has(name), `Missing tool: ${name}`).toBe(true);
			}
		});

		it("registers expected flags", () => {
			expect(mockPI.flags.has("chrome-profile")).toBe(true);
			expect(mockPI.flags.has("cdp-port")).toBe(true);
			expect(mockPI.flags.has("chrome-path")).toBe(true);
		});
	});

	describe("browser_launch", () => {
		it("returns install message when agent-browser is not installed", async () => {
			vi.mocked(isInstalled).mockReturnValue(false);

			const tool = mockPI.tools.get("browser_launch")!;
			const ctx = createMockCtx();
			const result = await tool.execute("id", {}, undefined, undefined, ctx);

			expect(result.content[0].text).toContain("agent-browser not found");
		});

		it("connects directly when CDP port is already open", async () => {
			vi.mocked(isInstalled).mockReturnValue(true);
			vi.mocked(detectChrome).mockResolvedValue({
				binary: "/usr/bin/google-chrome",
				userDataDir: "/home/user/.config/google-chrome",
				profiles: [],
				running: true,
				debugPortOpen: true,
				cdpPort: 9222,
			});
			vi.mocked(getCdpInfo).mockResolvedValue({
				browser: "Chrome/120.0",
				wsUrl: "ws://localhost:9222/devtools",
			});

			const tool = mockPI.tools.get("browser_launch")!;
			const ctx = createMockCtx();
			const result = await tool.execute("id", {}, undefined, undefined, ctx);

			expect(result.content[0].text).toContain("Connected to existing Chrome");
			expect(result.content[0].text).toContain("Chrome/120.0");
			// Should NOT prompt the user
			expect(ctx.ui.confirm).not.toHaveBeenCalled();
		});

		it("prompts user when Chrome is running without CDP", async () => {
			vi.mocked(isInstalled).mockReturnValue(true);
			vi.mocked(detectChrome).mockResolvedValue({
				binary: "/usr/bin/google-chrome",
				userDataDir: "/home/user/.config/google-chrome",
				profiles: [
					{ dirName: "Default", displayName: "Personal", path: "/tmp/Default", email: "user@test.com" },
				],
				running: true,
				debugPortOpen: false,
				cdpPort: 9222,
			});
			vi.mocked(ensureChromeWithCdp).mockResolvedValue({
				port: 9222,
				restarted: true,
				launched: false,
			});

			const tool = mockPI.tools.get("browser_launch")!;
			const ctx = createMockCtx({ confirmResult: true });
			await tool.execute("id", {}, undefined, undefined, ctx);

			// Should have asked
			expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
			expect(ctx.ui.confirm.mock.calls[0][0]).toBe("Browser Testing Setup");
			expect(ctx.ui.confirm.mock.calls[0][1]).toContain("Restart Chrome now?");
		});

		it("path 1: restarts Chrome when user confirms", async () => {
			vi.mocked(isInstalled).mockReturnValue(true);
			vi.mocked(detectChrome).mockResolvedValue({
				binary: "/usr/bin/google-chrome",
				userDataDir: "/tmp/chrome",
				profiles: [],
				running: true,
				debugPortOpen: false,
				cdpPort: 9222,
			});
			vi.mocked(ensureChromeWithCdp).mockResolvedValue({
				port: 9222,
				restarted: true,
				launched: false,
			});

			const tool = mockPI.tools.get("browser_launch")!;
			const ctx = createMockCtx({ confirmResult: true });
			const result = await tool.execute("id", {}, undefined, undefined, ctx);

			expect(ensureChromeWithCdp).toHaveBeenCalledWith({
				port: 9222,
				binary: undefined,
			});
			expect(result.content[0].text).toContain("Restarted Chrome");
			expect(result.content[0].text).toContain("All profiles and tabs restored");
		});

		it("path 1: does NOT pass profileDirName on restart (all profiles restore naturally)", async () => {
			vi.mocked(isInstalled).mockReturnValue(true);
			vi.mocked(detectChrome).mockResolvedValue({
				binary: "/usr/bin/google-chrome",
				userDataDir: "/tmp/chrome",
				profiles: [],
				running: true,
				debugPortOpen: false,
				cdpPort: 9222,
			});
			vi.mocked(ensureChromeWithCdp).mockResolvedValue({
				port: 9222,
				restarted: true,
				launched: false,
			});

			const tool = mockPI.tools.get("browser_launch")!;
			const ctx = createMockCtx({ confirmResult: true });
			await tool.execute("id", { profile: "Work" }, undefined, undefined, ctx);

			// Should NOT include profileDirName — let session restore handle it
			const call = vi.mocked(ensureChromeWithCdp).mock.calls[0][0];
			expect(call).not.toHaveProperty("profileDirName");
		});

		it("path 2: launches isolated browser when user declines restart", async () => {
			vi.mocked(isInstalled).mockReturnValue(true);
			vi.mocked(detectChrome).mockResolvedValue({
				binary: "/usr/bin/google-chrome",
				userDataDir: "/tmp/chrome",
				profiles: [
					{ dirName: "Default", displayName: "Personal", path: "/tmp/Default" },
				],
				running: true,
				debugPortOpen: false,
				cdpPort: 9222,
			});
			vi.mocked(launchIsolatedBrowser).mockResolvedValue({
				port: 9223,
				dataDir: "/home/user/.pi/browser-data",
				cookiesImported: ["Cookies", "Login Data"],
			});

			const tool = mockPI.tools.get("browser_launch")!;
			const ctx = createMockCtx({ confirmResult: false }); // decline restart
			const result = await tool.execute("id", {}, undefined, undefined, ctx);

			expect(launchIsolatedBrowser).toHaveBeenCalled();
			expect(result.content[0].text).toContain("Launched separate browser");
			expect(result.content[0].text).toContain("9223");
			expect(result.content[0].text).toContain("Your real Chrome is untouched");
			expect(result.content[0].text).toContain("Cookies, Login Data");
		});

		it("path 2: shows profile picker when multiple profiles exist", async () => {
			vi.mocked(isInstalled).mockReturnValue(true);
			vi.mocked(detectChrome).mockResolvedValue({
				binary: "/usr/bin/google-chrome",
				userDataDir: "/tmp/chrome",
				profiles: [
					{ dirName: "Default", displayName: "Personal", path: "/tmp/Default", email: "me@test.com" },
					{ dirName: "Profile 1", displayName: "Work", path: "/tmp/Profile 1", email: "work@company.com" },
				],
				running: true,
				debugPortOpen: false,
				cdpPort: 9222,
			});
			vi.mocked(launchIsolatedBrowser).mockResolvedValue({
				port: 9223,
				dataDir: "/home/user/.pi/browser-data",
				cookiesImported: [],
			});

			const tool = mockPI.tools.get("browser_launch")!;
			const ctx = createMockCtx({
				confirmResult: false,
				selectResult: "Work (work@company.com) [Profile 1]",
			});
			await tool.execute("id", {}, undefined, undefined, ctx);

			// Should show profile picker
			expect(ctx.ui.select).toHaveBeenCalledTimes(1);
			const selectOptions = ctx.ui.select.mock.calls[0][1];
			expect(selectOptions).toContain("Personal (me@test.com) [Default]");
			expect(selectOptions).toContain("Work (work@company.com) [Profile 1]");
			expect(selectOptions).toContain("Skip — don't import cookies");

			// Should use selected profile
			expect(launchIsolatedBrowser).toHaveBeenCalledWith(
				expect.objectContaining({ importFromProfile: "Profile 1" }),
			);
		});

		it("path 2: skips profile picker with single profile", async () => {
			vi.mocked(isInstalled).mockReturnValue(true);
			vi.mocked(detectChrome).mockResolvedValue({
				binary: "/usr/bin/google-chrome",
				userDataDir: "/tmp/chrome",
				profiles: [
					{ dirName: "Default", displayName: "Personal", path: "/tmp/Default" },
				],
				running: true,
				debugPortOpen: false,
				cdpPort: 9222,
			});
			vi.mocked(launchIsolatedBrowser).mockResolvedValue({
				port: 9223,
				dataDir: "/home/user/.pi/browser-data",
				cookiesImported: [],
			});

			const tool = mockPI.tools.get("browser_launch")!;
			const ctx = createMockCtx({ confirmResult: false });
			await tool.execute("id", {}, undefined, undefined, ctx);

			// Should NOT show profile picker — only one profile, use it directly
			expect(ctx.ui.select).not.toHaveBeenCalled();
			expect(launchIsolatedBrowser).toHaveBeenCalledWith(
				expect.objectContaining({ importFromProfile: "Default" }),
			);
		});

		it("path 2: user can skip cookie import", async () => {
			vi.mocked(isInstalled).mockReturnValue(true);
			vi.mocked(detectChrome).mockResolvedValue({
				binary: "/usr/bin/google-chrome",
				userDataDir: "/tmp/chrome",
				profiles: [
					{ dirName: "Default", displayName: "Personal", path: "/tmp/Default" },
					{ dirName: "Profile 1", displayName: "Work", path: "/tmp/Profile 1" },
				],
				running: true,
				debugPortOpen: false,
				cdpPort: 9222,
			});
			vi.mocked(launchIsolatedBrowser).mockResolvedValue({
				port: 9223,
				dataDir: "/home/user/.pi/browser-data",
				cookiesImported: [],
			});

			const tool = mockPI.tools.get("browser_launch")!;
			const ctx = createMockCtx({
				confirmResult: false,
				selectResult: "Skip — don't import cookies",
			});
			await tool.execute("id", {}, undefined, undefined, ctx);

			expect(launchIsolatedBrowser).toHaveBeenCalledWith(
				expect.objectContaining({ importFromProfile: undefined }),
			);
		});

		it("mode=restart skips the confirm dialog", async () => {
			vi.mocked(isInstalled).mockReturnValue(true);
			vi.mocked(detectChrome).mockResolvedValue({
				binary: "/usr/bin/google-chrome",
				userDataDir: "/tmp/chrome",
				profiles: [],
				running: true,
				debugPortOpen: false,
				cdpPort: 9222,
			});
			vi.mocked(ensureChromeWithCdp).mockResolvedValue({
				port: 9222,
				restarted: true,
				launched: false,
			});

			const tool = mockPI.tools.get("browser_launch")!;
			const ctx = createMockCtx();
			await tool.execute("id", { mode: "restart" }, undefined, undefined, ctx);

			expect(ctx.ui.confirm).not.toHaveBeenCalled();
			expect(ensureChromeWithCdp).toHaveBeenCalled();
		});

		it("mode=isolated skips the confirm dialog", async () => {
			vi.mocked(isInstalled).mockReturnValue(true);
			vi.mocked(detectChrome).mockResolvedValue({
				binary: "/usr/bin/google-chrome",
				userDataDir: "/tmp/chrome",
				profiles: [
					{ dirName: "Default", displayName: "Personal", path: "/tmp/Default" },
				],
				running: true,
				debugPortOpen: false,
				cdpPort: 9222,
			});
			vi.mocked(launchIsolatedBrowser).mockResolvedValue({
				port: 9223,
				dataDir: "/home/user/.pi/browser-data",
				cookiesImported: [],
			});

			const tool = mockPI.tools.get("browser_launch")!;
			const ctx = createMockCtx();
			await tool.execute("id", { mode: "isolated" }, undefined, undefined, ctx);

			expect(ctx.ui.confirm).not.toHaveBeenCalled();
			expect(launchIsolatedBrowser).toHaveBeenCalled();
		});

		it("launches directly when Chrome is not running (no prompt)", async () => {
			vi.mocked(isInstalled).mockReturnValue(true);
			vi.mocked(detectChrome).mockResolvedValue({
				binary: "/usr/bin/google-chrome",
				userDataDir: "/tmp/chrome",
				profiles: [],
				running: false,
				debugPortOpen: false,
				cdpPort: 9222,
			});
			vi.mocked(ensureChromeWithCdp).mockResolvedValue({
				port: 9222,
				restarted: false,
				launched: true,
			});

			const tool = mockPI.tools.get("browser_launch")!;
			const ctx = createMockCtx();
			const result = await tool.execute("id", {}, undefined, undefined, ctx);

			expect(ctx.ui.confirm).not.toHaveBeenCalled();
			expect(ensureChromeWithCdp).toHaveBeenCalled();
			expect(result.content[0].text).toContain("Launched Chrome with CDP enabled");
		});

		it("uses isolated port 9223 to avoid conflict with user Chrome on 9222", async () => {
			vi.mocked(isInstalled).mockReturnValue(true);
			vi.mocked(detectChrome).mockResolvedValue({
				binary: "/usr/bin/google-chrome",
				userDataDir: "/tmp/chrome",
				profiles: [],
				running: true,
				debugPortOpen: false,
				cdpPort: 9222,
			});
			vi.mocked(launchIsolatedBrowser).mockResolvedValue({
				port: 9223,
				dataDir: "/home/user/.pi/browser-data",
				cookiesImported: [],
			});

			const tool = mockPI.tools.get("browser_launch")!;
			const ctx = createMockCtx({ confirmResult: false });
			await tool.execute("id", {}, undefined, undefined, ctx);

			expect(launchIsolatedBrowser).toHaveBeenCalledWith(
				expect.objectContaining({ port: 9223 }),
			);
		});

		it("connects agent-browser to the correct CDP port after isolated launch", async () => {
			vi.mocked(isInstalled).mockReturnValue(true);
			vi.mocked(detectChrome).mockResolvedValue({
				binary: "/usr/bin/google-chrome",
				userDataDir: "/tmp/chrome",
				profiles: [],
				running: true,
				debugPortOpen: false,
				cdpPort: 9222,
			});
			vi.mocked(launchIsolatedBrowser).mockResolvedValue({
				port: 9223,
				dataDir: "/home/user/.pi/browser-data",
				cookiesImported: [],
			});

			const tool = mockPI.tools.get("browser_launch")!;
			const ctx = createMockCtx({ confirmResult: false });
			await tool.execute("id", {}, undefined, undefined, ctx);

			// runDirect should connect to 9223, not 9222
			expect(runDirect).toHaveBeenCalledWith(["connect", "9223"], { timeout: 10 });
		});
	});

	describe("tools requiring connection", () => {
		it("browser_go throws when not connected", async () => {
			const tool = mockPI.tools.get("browser_go")!;
			await expect(tool.execute("id", { url: "https://example.com" }, undefined, undefined, createMockCtx()))
				.rejects.toThrow("Not connected to Chrome");
		});

		it("browser_snapshot throws when not connected", async () => {
			const tool = mockPI.tools.get("browser_snapshot")!;
			await expect(tool.execute("id", {}, undefined, undefined, createMockCtx()))
				.rejects.toThrow("Not connected to Chrome");
		});

		it("browser_click throws when not connected", async () => {
			const tool = mockPI.tools.get("browser_click")!;
			await expect(tool.execute("id", { ref: "@e1" }, undefined, undefined, createMockCtx()))
				.rejects.toThrow("Not connected to Chrome");
		});

		it("browser_eval throws when not connected", async () => {
			const tool = mockPI.tools.get("browser_eval")!;
			await expect(tool.execute("id", { js: "1+1" }, undefined, undefined, createMockCtx()))
				.rejects.toThrow("Not connected to Chrome");
		});

		it("browser_close disconnects cleanly even when not connected", async () => {
			const tool = mockPI.tools.get("browser_close")!;
			const result = await tool.execute("id", {}, undefined, undefined, createMockCtx());
			expect(result.content[0].text).toContain("Disconnected");
		});
	});

	describe("browser_launch confirm dialog content", () => {
		it("mentions all profiles restore in the confirm message", async () => {
			vi.mocked(isInstalled).mockReturnValue(true);
			vi.mocked(detectChrome).mockResolvedValue({
				binary: "/usr/bin/google-chrome",
				userDataDir: "/tmp/chrome",
				profiles: [],
				running: true,
				debugPortOpen: false,
				cdpPort: 9222,
			});
			vi.mocked(ensureChromeWithCdp).mockResolvedValue({
				port: 9222,
				restarted: true,
				launched: false,
			});

			const tool = mockPI.tools.get("browser_launch")!;
			const ctx = createMockCtx({ confirmResult: true });
			await tool.execute("id", {}, undefined, undefined, ctx);

			const message = ctx.ui.confirm.mock.calls[0][1];
			expect(message).toContain("profiles will restore automatically");
			expect(message).toContain("everything comes back exactly as it was");
		});

		it("warns about manual restore in the confirm message", async () => {
			vi.mocked(isInstalled).mockReturnValue(true);
			vi.mocked(detectChrome).mockResolvedValue({
				binary: "/usr/bin/google-chrome",
				userDataDir: "/tmp/chrome",
				profiles: [],
				running: true,
				debugPortOpen: false,
				cdpPort: 9222,
			});
			vi.mocked(ensureChromeWithCdp).mockResolvedValue({
				port: 9222,
				restarted: true,
				launched: false,
			});

			const tool = mockPI.tools.get("browser_launch")!;
			const ctx = createMockCtx({ confirmResult: true });
			await tool.execute("id", {}, undefined, undefined, ctx);

			const message = ctx.ui.confirm.mock.calls[0][1];
			expect(message).toContain("restarting it at that point");
			expect(message).toContain("History");
			expect(message).toContain("Restore tabs");
		});
	});
});
