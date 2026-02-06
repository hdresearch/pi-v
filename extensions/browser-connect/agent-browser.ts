/**
 * Thin wrapper around the agent-browser CLI.
 * Calls agent-browser with --cdp and --json flags, parses output.
 */

import { execFile, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let agentBrowserPath: string | null = null;

function findAgentBrowser(): string {
	if (agentBrowserPath) return agentBrowserPath;

	try {
		const path = execSync("which agent-browser 2>/dev/null", { encoding: "utf-8" }).trim();
		if (path) {
			agentBrowserPath = path;
			return path;
		}
	} catch { /* not on PATH */ }

	throw new Error(
		"agent-browser not found. Install it:\n" +
		"  npm install -g agent-browser && agent-browser install"
	);
}

export interface AgentBrowserResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	/** Parsed JSON output if --json was used */
	json?: any;
}

/**
 * Run an agent-browser command with CDP connection.
 *
 * @param args - Command args (e.g., ["open", "https://example.com"])
 * @param cdpPort - CDP port to connect to
 * @param opts - Additional options
 */
export async function run(
	args: string[],
	cdpPort: number,
	opts: {
		json?: boolean;
		timeout?: number;
		headed?: boolean;
	} = {}
): Promise<AgentBrowserResult> {
	const binary = findAgentBrowser();

	const fullArgs: string[] = [
		"--cdp", String(cdpPort),
	];

	if (opts.json !== false) {
		fullArgs.push("--json");
	}

	if (opts.headed) {
		fullArgs.push("--headed");
	}

	fullArgs.push(...args);

	const timeoutMs = (opts.timeout || 30) * 1000;

	return new Promise((resolve, reject) => {
		execFile(binary, fullArgs, {
			maxBuffer: 10 * 1024 * 1024,
			timeout: timeoutMs,
			env: { ...process.env },
		}, (err, stdout, stderr) => {
			const exitCode = (err as any)?.status ?? (err ? 1 : 0);
			const result: AgentBrowserResult = {
				stdout: stdout?.toString() ?? "",
				stderr: stderr?.toString() ?? "",
				exitCode,
			};

			// Try to parse JSON output
			if (opts.json !== false && result.stdout.trim()) {
				try {
					result.json = JSON.parse(result.stdout.trim());
				} catch {
					// Not valid JSON, that's fine — some commands output plain text
				}
			}

			resolve(result);
		});
	});
}

/**
 * Run agent-browser without CDP (for initial open/connect).
 */
export async function runDirect(
	args: string[],
	opts: { json?: boolean; timeout?: number } = {}
): Promise<AgentBrowserResult> {
	const binary = findAgentBrowser();

	const fullArgs: string[] = [];
	if (opts.json !== false) {
		fullArgs.push("--json");
	}
	fullArgs.push(...args);

	const timeoutMs = (opts.timeout || 30) * 1000;

	return new Promise((resolve) => {
		execFile(binary, fullArgs, {
			maxBuffer: 10 * 1024 * 1024,
			timeout: timeoutMs,
			env: { ...process.env },
		}, (err, stdout, stderr) => {
			const exitCode = (err as any)?.status ?? (err ? 1 : 0);
			const result: AgentBrowserResult = {
				stdout: stdout?.toString() ?? "",
				stderr: stderr?.toString() ?? "",
				exitCode,
			};

			if (opts.json !== false && result.stdout.trim()) {
				try {
					result.json = JSON.parse(result.stdout.trim());
				} catch { /* not JSON */ }
			}

			resolve(result);
		});
	});
}

/**
 * Generate a temp path for screenshots.
 */
export function screenshotPath(): string {
	return join(tmpdir(), `pi-browser-${Date.now()}.png`);
}

/**
 * Check if agent-browser is available.
 */
export function isInstalled(): boolean {
	try {
		findAgentBrowser();
		return true;
	} catch {
		return false;
	}
}

/**
 * Install agent-browser globally.
 */
export async function install(): Promise<void> {
	execSync("npm install -g agent-browser", { stdio: "inherit" });
	execSync("agent-browser install", { stdio: "inherit" });
	agentBrowserPath = null; // reset cache
}
