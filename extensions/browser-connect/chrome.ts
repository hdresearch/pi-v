/**
 * Chrome detection, profile discovery, and launch management.
 * Handles macOS and Linux. Finds Chrome binary, enumerates profiles,
 * detects running instances, and manages CDP debug port.
 */

import { execSync, exec, spawn as nodeSpawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

export interface ChromeProfile {
	/** Directory name: "Default", "Profile 1", etc. */
	dirName: string;
	/** Display name from Chrome Preferences */
	displayName: string;
	/** Full path to profile directory */
	path: string;
	/** Email associated with profile (if signed in) */
	email?: string;
}

export interface ChromeInfo {
	binary: string | null;
	userDataDir: string | null;
	profiles: ChromeProfile[];
	running: boolean;
	debugPortOpen: boolean;
	cdpPort: number;
}

const DEFAULT_CDP_PORT = 9222;

// ─── Chrome Binary Detection ────────────────────────────────────────────────

const CHROME_PATHS_MACOS = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];

const CHROME_PATHS_LINUX = [
	"google-chrome",
	"google-chrome-stable",
	"chromium-browser",
	"chromium",
	"brave-browser",
];

function findChromeBinary(): string | null {
	const os = platform();

	if (os === "darwin") {
		for (const p of CHROME_PATHS_MACOS) {
			if (existsSync(p)) return p;
		}
	} else if (os === "linux") {
		for (const name of CHROME_PATHS_LINUX) {
			try {
				const path = execSync(`which ${name} 2>/dev/null`, { encoding: "utf-8" }).trim();
				if (path) return path;
			} catch { /* not found, try next */ }
		}
	}

	return null;
}

// ─── User Data Directory ────────────────────────────────────────────────────

function getUserDataDir(): string | null {
	const home = homedir();
	const os = platform();

	const candidates = os === "darwin"
		? [
			join(home, "Library/Application Support/Google/Chrome"),
			join(home, "Library/Application Support/Google/Chrome Canary"),
			join(home, "Library/Application Support/Chromium"),
			join(home, "Library/Application Support/BraveSoftware/Brave-Browser"),
		]
		: [
			join(home, ".config/google-chrome"),
			join(home, ".config/chromium"),
			join(home, ".config/BraveSoftware/Brave-Browser"),
		];

	for (const dir of candidates) {
		if (existsSync(dir)) return dir;
	}
	return null;
}

// ─── Profile Discovery ─────────────────────────────────────────────────────

export function discoverProfiles(userDataDir?: string): ChromeProfile[] {
	const dir = userDataDir || getUserDataDir();
	if (!dir || !existsSync(dir)) return [];

	const profiles: ChromeProfile[] = [];

	// Scan for Default and Profile N directories
	const entries = readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (entry.name !== "Default" && !entry.name.startsWith("Profile ")) continue;

		const profileDir = join(dir, entry.name);
		const prefsPath = join(profileDir, "Preferences");
		if (!existsSync(prefsPath)) continue;

		try {
			const prefs = JSON.parse(readFileSync(prefsPath, "utf-8"));
			const displayName = prefs?.profile?.name || entry.name;
			const email = prefs?.account_info?.[0]?.email || prefs?.google?.services?.signin?.email || undefined;

			profiles.push({
				dirName: entry.name,
				displayName,
				path: profileDir,
				email,
			});
		} catch {
			// Corrupted preferences, skip
			profiles.push({
				dirName: entry.name,
				displayName: entry.name,
				path: profileDir,
			});
		}
	}

	return profiles.sort((a, b) => {
		// Default first, then by name
		if (a.dirName === "Default") return -1;
		if (b.dirName === "Default") return 1;
		return a.displayName.localeCompare(b.displayName);
	});
}

// ─── Runtime Detection ──────────────────────────────────────────────────────

function isChromeRunning(): boolean {
	try {
		const os = platform();
		if (os === "darwin") {
			// Only check for the main Chrome process, not helpers/renderers
			// The main process doesn't have --type= flag
			const out = execSync(
				`ps -eo pid,comm | grep -i 'Google Chrome$' | grep -v grep`,
				{ encoding: "utf-8" }
			);
			return out.trim().length > 0;
		} else {
			// On Linux, check for main browser process (no --type flag)
			const out = execSync(
				`ps -eo pid,args | grep -E '(chrome|chromium)' | grep -v -- '--type=' | grep -v grep`,
				{ encoding: "utf-8" }
			);
			return out.trim().length > 0;
		}
	} catch {
		return false;
	}
}

export async function isDebugPortOpen(port: number = DEFAULT_CDP_PORT): Promise<boolean> {
	try {
		const res = await fetch(`http://localhost:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
		return res.ok;
	} catch {
		return false;
	}
}

export async function getCdpInfo(port: number = DEFAULT_CDP_PORT): Promise<{ browser: string; wsUrl: string } | null> {
	try {
		const res = await fetch(`http://localhost:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
		if (!res.ok) return null;
		const data = await res.json() as { Browser?: string; webSocketDebuggerUrl?: string };
		return {
			browser: data.Browser || "unknown",
			wsUrl: data.webSocketDebuggerUrl || "",
		};
	} catch {
		return null;
	}
}

// ─── Chrome Launch / Relaunch ───────────────────────────────────────────────

/**
 * Gracefully quit Chrome. On macOS uses AppleScript for clean shutdown
 * which triggers session restore on next launch.
 */
export function quitChrome(): Promise<void> {
	return new Promise((resolve) => {
		const os = platform();
		if (os === "darwin") {
			// AppleScript quit triggers session save for restore on next launch
			exec(`osascript -e 'tell application "Google Chrome" to quit'`, () => {
				// Wait a bit, then if still running, SIGTERM the main process
				setTimeout(() => {
					try {
						const pid = execSync(`ps -eo pid,comm | grep 'Google Chrome$' | grep -v grep | awk '{print $1}'`, { encoding: "utf-8" }).trim();
						if (pid) {
							// AppleScript didn't work, force with SIGTERM (still triggers session save)
							exec(`kill -TERM ${pid}`, () => setTimeout(resolve, 3000));
						} else {
							resolve();
						}
					} catch {
						resolve();
					}
				}, 3000);
			});
		} else {
			exec("pkill -TERM -f 'chrome --' 2>/dev/null || pkill -TERM chromium 2>/dev/null", () => {
				setTimeout(resolve, 3000);
			});
		}
	});
}

/**
 * Wait for Chrome to fully exit.
 */
async function waitForChromeExit(timeoutMs: number = 15000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (!isChromeRunning()) return true;
		await new Promise(r => setTimeout(r, 500));
	}
	return false;
}

/**
 * Force-kill all Chrome processes. Used when graceful quit doesn't work.
 */
export function forceKillChrome(): Promise<void> {
	return new Promise((resolve) => {
		const os = platform();
		if (os === "darwin") {
			exec("pkill -9 'Google Chrome' 2>/dev/null; pkill -9 'Google Chrome Helper' 2>/dev/null", () => {
				setTimeout(resolve, 2000);
			});
		} else {
			exec("pkill -9 chrome 2>/dev/null; pkill -9 chromium 2>/dev/null", () => {
				setTimeout(resolve, 2000);
			});
		}
	});
}

/**
 * Launch Chrome with CDP debug port enabled.
 * If profileDir is provided, uses --profile-directory flag.
 *
 * IMPORTANT: Chrome ignores --remote-debugging-port if an existing instance
 * is already running ("Opening in existing browser session"). We must ensure
 * Chrome is fully dead before launching, and launch the binary directly
 * (not via `open -a` which reconnects to existing).
 */
export function launchChrome(opts: {
	port?: number;
	profileDirName?: string;
	userDataDir?: string;
	binary?: string;
}): void {
	const port = opts.port || DEFAULT_CDP_PORT;
	const binary = opts.binary || findChromeBinary();
	if (!binary) throw new Error("Chrome not found. Install Google Chrome or set --chrome-path.");

	const args: string[] = [`--remote-debugging-port=${port}`];

	if (opts.profileDirName) {
		args.push(`--profile-directory=${opts.profileDirName}`);
	}

	// Launch binary directly — NOT via `open -a` which may reconnect to
	// an existing Chrome instance that doesn't have the debug port.
	// Use spawn to detach the process.
	const child = nodeSpawn(binary, args, {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
}

/**
 * Wait for CDP port to become available after launch.
 */
export async function waitForCdp(port: number = DEFAULT_CDP_PORT, timeoutMs: number = 15000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await isDebugPortOpen(port)) return true;
		await new Promise(r => setTimeout(r, 500));
	}
	return false;
}

// ─── Main Detect / Connect Flow ─────────────────────────────────────────────

export async function detectChrome(port: number = DEFAULT_CDP_PORT): Promise<ChromeInfo> {
	const binary = findChromeBinary();
	const userDataDir = getUserDataDir();
	const profiles = discoverProfiles(userDataDir || undefined);
	const running = isChromeRunning();
	const debugPortOpen = await isDebugPortOpen(port);

	return { binary, userDataDir, profiles, running, debugPortOpen, cdpPort: port };
}

/**
 * Ensure Chrome is running with CDP enabled.
 * Returns the CDP port number on success.
 *
 * Strategy:
 *   1. If debug port already open → return immediately
 *   2. If Chrome running without debug port → quit + relaunch with port
 *   3. If Chrome not running → launch with port
 */
export async function ensureChromeWithCdp(opts: {
	port?: number;
	profileDirName?: string;
	binary?: string;
} = {}): Promise<{ port: number; restarted: boolean; launched: boolean }> {
	const port = opts.port || DEFAULT_CDP_PORT;

	// Already have CDP?
	if (await isDebugPortOpen(port)) {
		return { port, restarted: false, launched: false };
	}

	const running = isChromeRunning();

	if (running) {
		// Chrome running but no debug port — need to restart
		await quitChrome();
		let exited = await waitForChromeExit();
		if (!exited) {
			// Graceful quit didn't work — force kill
			await forceKillChrome();
			exited = await waitForChromeExit(5000);
			if (!exited) {
				throw new Error("Chrome didn't exit after quit + force kill. Close Chrome manually and try again.");
			}
		}
		launchChrome({ port, profileDirName: opts.profileDirName, binary: opts.binary });
		const ready = await waitForCdp(port);
		if (!ready) throw new Error(`Chrome launched but CDP port ${port} not responding.`);
		return { port, restarted: true, launched: false };
	}

	// Chrome not running — launch fresh
	launchChrome({ port, profileDirName: opts.profileDirName, binary: opts.binary });
	const ready = await waitForCdp(port);
	if (!ready) throw new Error(`Chrome launched but CDP port ${port} not responding.`);
	return { port, restarted: false, launched: true };
}

// ─── Isolated Pi Browser (fallback when user declines restart) ──────────────

/** Data dir for the isolated pi browser — persists between sessions */
function getPiBrowserDataDir(): string {
	return join(homedir(), ".pi", "browser-data");
}

/**
 * Import cookies and login data from an existing Chrome profile into the
 * isolated pi browser data dir. Only copies if destination doesn't already
 * exist (won't overwrite established pi browser sessions).
 */
export function importCookiesFromProfile(profileDirName: string, userDataDir?: string): { imported: string[] } {
	const srcDir = userDataDir || getUserDataDir();
	if (!srcDir) throw new Error("Chrome user data directory not found.");

	const srcProfile = join(srcDir, profileDirName);
	if (!existsSync(srcProfile)) {
		throw new Error(`Chrome profile "${profileDirName}" not found at ${srcProfile}`);
	}

	const destDir = join(getPiBrowserDataDir(), "Default");
	mkdirSync(destDir, { recursive: true });

	const filesToCopy = ["Cookies", "Cookies-journal", "Login Data", "Login Data-journal"];
	const imported: string[] = [];

	for (const file of filesToCopy) {
		const src = join(srcProfile, file);
		const dest = join(destDir, file);
		if (existsSync(src) && !existsSync(dest)) {
			copyFileSync(src, dest);
			imported.push(file);
		}
	}

	return { imported };
}

/**
 * Launch an isolated Chrome instance with its own user-data-dir.
 * This is completely separate from the user's normal Chrome — no windows
 * killed, no sessions touched. Uses ~/.pi/browser-data/ for persistence.
 *
 * Use a different CDP port (default 9223) to avoid conflicts if the user
 * later starts their real Chrome with CDP on 9222.
 */
export async function launchIsolatedBrowser(opts: {
	port?: number;
	importFromProfile?: string;
	binary?: string;
} = {}): Promise<{ port: number; dataDir: string; cookiesImported: string[] }> {
	const port = opts.port || 9223;
	const dataDir = getPiBrowserDataDir();
	const binary = opts.binary || findChromeBinary();
	if (!binary) throw new Error("Chrome not found. Install Google Chrome or set --chrome-path.");

	// Already running on this port?
	if (await isDebugPortOpen(port)) {
		return { port, dataDir, cookiesImported: [] };
	}

	// Import cookies if requested
	let cookiesImported: string[] = [];
	if (opts.importFromProfile) {
		const result = importCookiesFromProfile(opts.importFromProfile);
		cookiesImported = result.imported;
	}

	const args = [
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${dataDir}`,
		"--no-first-run",
		"--no-default-browser-check",
	];

	const child = nodeSpawn(binary, args, {
		detached: true,
		stdio: "ignore",
	});
	child.unref();

	const ready = await waitForCdp(port, 15000);
	if (!ready) throw new Error(`Isolated browser launched but CDP port ${port} not responding.`);

	return { port, dataDir, cookiesImported };
}
