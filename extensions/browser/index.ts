/**
 * Browser Extension
 *
 * Provides tools to control a headless Chrome browser via Puppeteer.
 * Tools: browser_open, browser_screenshot, browser_click, browser_type,
 *        browser_eval, browser_console, browser_close
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import puppeteer, { type Browser, type Page } from "puppeteer";

export default function browserExtension(pi: ExtensionAPI) {
	let browser: Browser | undefined;
	let page: Page | undefined;
	const consoleLogs: string[] = [];

	async function ensureBrowser(): Promise<Page> {
		if (!browser || !browser.connected) {
			browser = await puppeteer.launch({
				headless: true,
				args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
			});
			page = await browser.newPage();
			await page.setViewport({ width: 1280, height: 900 });

			// Capture console messages
			page.on("console", (msg) => {
				const entry = `[${msg.type()}] ${msg.text()}`;
				consoleLogs.push(entry);
				// Keep last 200 entries
				if (consoleLogs.length > 200) consoleLogs.shift();
			});

			page.on("pageerror", (err) => {
				consoleLogs.push(`[error] ${err.message}`);
				if (consoleLogs.length > 200) consoleLogs.shift();
			});
		}
		return page!;
	}

	// =========================================================================
	// Tools
	// =========================================================================

	pi.registerTool({
		name: "browser_open",
		label: "Browser Open",
		description:
			"Navigate to a URL in a headless Chrome browser. Returns a screenshot of the page after loading.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to navigate to" }),
			waitFor: Type.Optional(
				Type.Number({ description: "Extra milliseconds to wait after load (default: 1000)" }),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const { url, waitFor } = params as { url: string; waitFor?: number };
			consoleLogs.length = 0;
			const p = await ensureBrowser();
			await p.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
			if (waitFor) await new Promise((r) => setTimeout(r, waitFor));
			const screenshot = await p.screenshot({ encoding: "base64", fullPage: false });
			const title = await p.title();
			const pageUrl = p.url();
			return {
				content: [
					{ type: "text", text: `Navigated to: ${pageUrl}\nTitle: ${title}` },
					{
						type: "image",
						source: { type: "base64", media_type: "image/png", data: screenshot as string },
					},
				],
				details: { url: pageUrl, title },
			};
		},
	});

	pi.registerTool({
		name: "browser_screenshot",
		label: "Browser Screenshot",
		description: "Take a screenshot of the current browser page.",
		parameters: Type.Object({
			fullPage: Type.Optional(
				Type.Boolean({ description: "Capture full scrollable page (default: false)" }),
			),
			selector: Type.Optional(
				Type.String({ description: "CSS selector to screenshot a specific element" }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { fullPage, selector } = params as { fullPage?: boolean; selector?: string };
			const p = await ensureBrowser();

			let screenshot: string;
			if (selector) {
				const el = await p.$(selector);
				if (!el) {
					return {
						content: [{ type: "text", text: `Element not found: ${selector}` }],
						isError: true,
						details: {},
					};
				}
				screenshot = (await el.screenshot({ encoding: "base64" })) as string;
			} else {
				screenshot = (await p.screenshot({
					encoding: "base64",
					fullPage: fullPage ?? false,
				})) as string;
			}

			return {
				content: [
					{
						type: "image",
						source: { type: "base64", media_type: "image/png", data: screenshot },
					},
				],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "browser_click",
		label: "Browser Click",
		description: "Click an element on the page by CSS selector.",
		parameters: Type.Object({
			selector: Type.String({ description: "CSS selector of element to click" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { selector } = params as { selector: string };
			const p = await ensureBrowser();

			try {
				await p.click(selector);
				await new Promise((r) => setTimeout(r, 500));
				const screenshot = await p.screenshot({ encoding: "base64", fullPage: false });
				return {
					content: [
						{ type: "text", text: `Clicked: ${selector}` },
						{
							type: "image",
							source: { type: "base64", media_type: "image/png", data: screenshot as string },
						},
					],
					details: {},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Click failed on "${selector}": ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					isError: true,
					details: {},
				};
			}
		},
	});

	pi.registerTool({
		name: "browser_type",
		label: "Browser Type",
		description: "Type text into an input element.",
		parameters: Type.Object({
			selector: Type.String({ description: "CSS selector of input element" }),
			text: Type.String({ description: "Text to type" }),
			clear: Type.Optional(
				Type.Boolean({ description: "Clear the field before typing (default: true)" }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { selector, text, clear } = params as {
				selector: string;
				text: string;
				clear?: boolean;
			};
			const p = await ensureBrowser();

			try {
				if (clear !== false) {
					await p.click(selector, { count: 3 }); // select all
					await p.keyboard.press("Backspace");
				}
				await p.type(selector, text);
				return {
					content: [{ type: "text", text: `Typed into ${selector}: "${text}"` }],
					details: {},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Type failed on "${selector}": ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					isError: true,
					details: {},
				};
			}
		},
	});

	pi.registerTool({
		name: "browser_eval",
		label: "Browser Eval",
		description:
			"Execute JavaScript in the browser page context. Returns the result as JSON.",
		parameters: Type.Object({
			expression: Type.String({ description: "JavaScript expression to evaluate in the page" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { expression } = params as { expression: string };
			const p = await ensureBrowser();

			try {
				const result = await p.evaluate(expression);
				const output = JSON.stringify(result, null, 2) ?? "undefined";
				return {
					content: [{ type: "text", text: output }],
					details: { result },
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Eval error: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					isError: true,
					details: {},
				};
			}
		},
	});

	pi.registerTool({
		name: "browser_console",
		label: "Browser Console",
		description:
			"Get captured console output (log, warn, error, pageerror) from the browser page.",
		parameters: Type.Object({
			last: Type.Optional(
				Type.Number({ description: "Number of recent entries to return (default: 50)" }),
			),
			clear: Type.Optional(Type.Boolean({ description: "Clear the log after reading" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { last, clear } = params as { last?: number; clear?: boolean };
			const count = last ?? 50;
			const entries = consoleLogs.slice(-count);
			const output = entries.length > 0 ? entries.join("\n") : "(no console output captured)";
			if (clear) consoleLogs.length = 0;
			return {
				content: [{ type: "text", text: output }],
				details: { count: entries.length },
			};
		},
	});

	pi.registerTool({
		name: "browser_close",
		label: "Browser Close",
		description: "Close the browser instance.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			if (browser) {
				await browser.close();
				browser = undefined;
				page = undefined;
				consoleLogs.length = 0;
			}
			return {
				content: [{ type: "text", text: "Browser closed." }],
				details: {},
			};
		},
	});

	// Clean up on shutdown
	pi.on("session_shutdown", async () => {
		if (browser) {
			await browser.close().catch(() => {});
			browser = undefined;
			page = undefined;
		}
	});
}
