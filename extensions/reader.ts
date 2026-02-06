/**
 * Reader Extension
 *
 * Provides a `fetch_page` tool that fetches a webpage and returns its content
 * in reader mode — stripped of scripts, styles, nav, ads, and other noise.
 * Returns clean text with basic structure (headings, links, lists) preserved.
 *
 * No external dependencies — uses Node.js built-in fetch + simple HTML parsing.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

/**
 * Minimal HTML-to-readable-text converter.
 * Strips scripts, styles, nav, header, footer, aside, and extracts text content
 * with basic structural markers for headings, links, and list items.
 */
function htmlToReadable(html: string): string {
	// Remove comments
	let text = html.replace(/<!--[\s\S]*?-->/g, "");

	// Remove entire blocks that are noise
	const noiseBlocks = ["script", "style", "noscript", "svg", "nav", "header", "footer", "aside", "iframe"];
	for (const tag of noiseBlocks) {
		const re = new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, "gi");
		text = text.replace(re, "");
	}

	// Remove hidden elements
	text = text.replace(/<[^>]+(?:hidden|display\s*:\s*none|aria-hidden\s*=\s*"true")[^>]*>[\s\S]*?<\/[^>]+>/gi, "");

	// Convert headings to markdown-style markers
	text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
	text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
	text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
	text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n");
	text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n");
	text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n");

	// Convert links: keep text and URL
	text = text.replace(/<a[^>]+href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)");
	text = text.replace(/<a[^>]+href\s*=\s*'([^']*)'[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)");

	// Convert images to alt text
	text = text.replace(/<img[^>]+alt\s*=\s*"([^"]*)"[^>]*\/?>/gi, "[image: $1]");
	text = text.replace(/<img[^>]*\/?>/gi, "");

	// Convert list items
	text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");

	// Convert paragraphs and divs to newlines
	text = text.replace(/<\/(?:p|div|section|article|blockquote|tr)>/gi, "\n");
	text = text.replace(/<(?:br|hr)\s*\/?>/gi, "\n");

	// Convert table cells
	text = text.replace(/<\/t[dh]>/gi, "\t");

	// Convert pre/code blocks — preserve content
	text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n");

	// Strip all remaining HTML tags
	text = text.replace(/<[^>]+>/g, "");

	// Decode common HTML entities
	text = text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));

	// Clean up whitespace
	text = text
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.join("\n");

	// Collapse multiple blank lines
	text = text.replace(/\n{3,}/g, "\n\n");

	return text.trim();
}

/**
 * Try to extract the "main" content area from HTML using common patterns.
 * Falls back to <body> or the full document.
 */
function extractMainContent(html: string): string {
	// Try <article>, <main>, or role="main" first
	const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
	if (articleMatch && articleMatch[1].length > 200) {
		return articleMatch[1];
	}

	const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
	if (mainMatch && mainMatch[1].length > 200) {
		return mainMatch[1];
	}

	const roleMainMatch = html.match(/<[^>]+role\s*=\s*"main"[^>]*>([\s\S]*?)<\/[^>]+>/i);
	if (roleMainMatch && roleMainMatch[1].length > 200) {
		return roleMainMatch[1];
	}

	// Try common content IDs/classes
	const contentPatterns = [
		/<div[^>]+id\s*=\s*"content"[^>]*>([\s\S]*?)<\/div>/i,
		/<div[^>]+class\s*=\s*"[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
		/<div[^>]+id\s*=\s*"article"[^>]*>([\s\S]*?)<\/div>/i,
		/<div[^>]+class\s*=\s*"[^"]*post-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
		/<div[^>]+class\s*=\s*"[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
	];

	for (const pattern of contentPatterns) {
		const match = html.match(pattern);
		if (match && match[1].length > 200) {
			return match[1];
		}
	}

	// Fall back to body
	const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
	if (bodyMatch) {
		return bodyMatch[1];
	}

	return html;
}

/**
 * Extract page title from HTML.
 */
function extractTitle(html: string): string | undefined {
	const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	if (match) {
		return match[1].replace(/<[^>]+>/g, "").trim();
	}
	return undefined;
}

/**
 * Extract meta description from HTML.
 */
function extractDescription(html: string): string | undefined {
	const match = html.match(/<meta[^>]+name\s*=\s*"description"[^>]+content\s*=\s*"([^"]*)"[^>]*\/?>/i);
	if (match) return match[1].trim();
	const match2 = html.match(/<meta[^>]+content\s*=\s*"([^"]*)"[^>]+name\s*=\s*"description"[^>]*\/?>/i);
	if (match2) return match2[1].trim();
	return undefined;
}

export default function readerExtension(api: ExtensionAPI): void {
	api.registerTool(
		"fetch_page",
		"Fetch a webpage and return its content in reader mode (clean text, no CSS/JS/ads). Useful for reading documentation, articles, or any web content.",
		Type.Object({
			url: Type.String({ description: "URL of the page to fetch" }),
			raw: Type.Optional(Type.Boolean({ description: "Return raw HTML instead of reader mode (default: false)" })),
			max_length: Type.Optional(Type.Number({ description: "Max characters to return (default: 50000)" })),
		}),
		async (args) => {
			const url = args.url as string;
			const raw = args.raw as boolean | undefined;
			const maxLength = (args.max_length as number | undefined) ?? 50000;

			try {
				const response = await fetch(url, {
					headers: {
						"User-Agent": "Mozilla/5.0 (compatible; pi-reader/1.0)",
						Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
						"Accept-Language": "en-US,en;q=0.5",
					},
					redirect: "follow",
					signal: AbortSignal.timeout(15000),
				});

				if (!response.ok) {
					return `Error: HTTP ${response.status} ${response.statusText}`;
				}

				const contentType = response.headers.get("content-type") ?? "";

				// If not HTML, return raw text
				if (!contentType.includes("html")) {
					const text = await response.text();
					return text.length > maxLength ? text.slice(0, maxLength) + "\n\n[truncated]" : text;
				}

				const html = await response.text();

				if (raw) {
					return html.length > maxLength ? html.slice(0, maxLength) + "\n\n[truncated]" : html;
				}

				const title = extractTitle(html);
				const description = extractDescription(html);
				const mainContent = extractMainContent(html);
				const readable = htmlToReadable(mainContent);

				let result = "";
				if (title) result += `# ${title}\n\n`;
				if (description) result += `> ${description}\n\n`;
				result += readable;

				return result.length > maxLength ? result.slice(0, maxLength) + "\n\n[truncated]" : result;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Error fetching ${url}: ${message}`;
			}
		}
	);
}
