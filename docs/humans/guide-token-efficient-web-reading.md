# Build a Token-Efficient Web Reader for Your Coding Agent

> Give your agent the ability to read any web page without blowing your context window. We'll build a pi extension that fetches pages, strips the noise, and returns clean markdown-like text — no external dependencies.

## What You'll Have at the End

- A `fetch_page` tool your agent can call to read any URL
- HTML→readable text conversion that strips scripts, styles, nav, ads, and boilerplate
- Content extraction that finds the `<article>` or `<main>` section automatically
- 50KB output cap so a single page can't flood your context

## Before You Start

```bash
npm install -g @mariozechner/pi-coding-agent
```

That's it. This extension uses Node.js built-in `fetch` and regex — no npm dependencies.

## Step 1: Create the Extension

Create `~/.pi/agent/extensions/reader.ts`:

```typescript
// ~/.pi/agent/extensions/reader.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function readerExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "fetch_page",
    label: "Fetch Page",
    description: "Fetch a webpage and return its content in reader mode (clean text, no CSS/JS/ads).",
    parameters: Type.Object({
      url: Type.String({ description: "URL of the page to fetch" }),
      raw: Type.Optional(Type.Boolean({ description: "Return raw HTML instead of reader mode" })),
      max_length: Type.Optional(Type.Number({ description: "Max characters to return (default: 50000)" })),
    }),
    async execute(_toolCallId, params) {
      const { url, raw, max_length } = params;
      const maxLength = max_length ?? 50000;

      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; pi-reader/1.0)" },
        redirect: "follow",
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        return { content: [{ type: "text", text: `Error: HTTP ${response.status}` }] };
      }

      const html = await response.text();
      if (raw) {
        const out = html.length > maxLength ? html.slice(0, maxLength) + "\n\n[truncated]" : html;
        return { content: [{ type: "text", text: out }] };
      }

      const readable = htmlToReadable(extractMainContent(html));
      const title = extractTitle(html);

      let result = title ? `# ${title}\n\n` : "";
      result += readable;
      const out = result.length > maxLength ? result.slice(0, maxLength) + "\n\n[truncated]" : result;

      return { content: [{ type: "text", text: out }] };
    },
  });
}
```

Reload pi (`/reload`). Ask it to fetch any URL. You'll get... raw HTML. We need the conversion functions.

## Step 2: Extract the Main Content

Most pages have a `<main>` or `<article>` tag wrapping the actual content. Everything else — nav, sidebar, footer — is noise. Add this above the default export:

```typescript
function extractMainContent(html: string): string {
  // Try semantic tags first
  for (const tag of ["article", "main"]) {
    const match = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
    if (match && match[1].length > 200) return match[1];
  }

  // Try role="main"
  const roleMatch = html.match(/<[^>]+role\s*=\s*"main"[^>]*>([\s\S]*?)<\/[^>]+>/i);
  if (roleMatch && roleMatch[1].length > 200) return roleMatch[1];

  // Try common content class/ID patterns
  const patterns = [
    /<div[^>]+id\s*=\s*"content"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]+class\s*=\s*"[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]+class\s*=\s*"[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1].length > 200) return m[1];
  }

  // Fall back to body
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return body ? body[1] : html;
}
```

The 200-character minimum prevents matching empty containers. If nothing matches, we fall back to the full `<body>`.

## Step 3: Convert HTML to Readable Text

This is the core — turn HTML into something an LLM can read without burning tokens on `<div class="flex items-center justify-between px-4 py-2 bg-gradient-to-r from-blue-500">`. Add this function:

```typescript
function htmlToReadable(html: string): string {
  let text = html;

  // Remove noise blocks entirely
  for (const tag of ["script", "style", "noscript", "svg", "nav", "header", "footer", "aside", "iframe"]) {
    text = text.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, "gi"), "");
  }

  // Convert structure to markdown
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, content) =>
    `\n${"#".repeat(Number(level))} ${content}\n`
  );
  text = text.replace(/<a[^>]+href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)");
  text = text.replace(/<img[^>]+alt\s*=\s*"([^"]*)"[^>]*\/?>/gi, "[image: $1]");
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n");
  text = text.replace(/<\/(?:p|div|section|article|blockquote|tr)>/gi, "\n");
  text = text.replace(/<(?:br|hr)\s*\/?>/gi, "\n");

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode entities
  text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");

  // Clean whitespace
  text = text.split("\n").map(line => line.replace(/\s+/g, " ").trim()).join("\n");
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/<[^>]+>/g, "").trim() : undefined;
}
```

Reload. Now `fetch_page` returns clean text:

```
> fetch_page https://example.com

# Example Domain

Example Domain
This domain is for use in documentation examples. Learn more (https://iana.org/domains/example)
```

## Step 4: Test on a Real Page

Try a documentation page with heavy markup:

```
fetch_page --url "https://docs.github.com/en/get-started/quickstart/hello-world"
```

You'll get the article content with headings, links, and code blocks — without the GitHub nav, sidebar, footer, or any CSS/JS. A page that was 200KB of HTML becomes ~5KB of readable text.

Compare with raw mode to see the difference:

```
fetch_page --url "https://docs.github.com/en/get-started/quickstart/hello-world" --raw true
```

The raw HTML is 10-40x larger. That's 10-40x more tokens consumed from your context window for the same information.

## The Complete Extension

Here's the full file — copy it to `~/.pi/agent/extensions/reader.ts`:

```typescript
// ~/.pi/agent/extensions/reader.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

function htmlToReadable(html: string): string {
  let text = html.replace(/<!--[\s\S]*?-->/g, "");

  for (const tag of ["script", "style", "noscript", "svg", "nav", "header", "footer", "aside", "iframe"]) {
    text = text.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, "gi"), "");
  }

  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, content) =>
    `\n${"#".repeat(Number(level))} ${content}\n`
  );
  text = text.replace(/<a[^>]+href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)");
  text = text.replace(/<img[^>]+alt\s*=\s*"([^"]*)"[^>]*\/?>/gi, "[image: $1]");
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n");
  text = text.replace(/<\/(?:p|div|section|article|blockquote|tr)>/gi, "\n");
  text = text.replace(/<(?:br|hr)\s*\/?>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
  text = text.split("\n").map(line => line.replace(/\s+/g, " ").trim()).join("\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function extractMainContent(html: string): string {
  for (const tag of ["article", "main"]) {
    const m = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
    if (m && m[1].length > 200) return m[1];
  }
  const role = html.match(/<[^>]+role\s*=\s*"main"[^>]*>([\s\S]*?)<\/[^>]+>/i);
  if (role && role[1].length > 200) return role[1];
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return body ? body[1] : html;
}

function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : undefined;
}

function extractDescription(html: string): string | undefined {
  const m = html.match(/<meta[^>]+name\s*=\s*"description"[^>]+content\s*=\s*"([^"]*)"[^>]*\/?>/i)
    || html.match(/<meta[^>]+content\s*=\s*"([^"]*)"[^>]+name\s*=\s*"description"[^>]*\/?>/i);
  return m ? m[1].trim() : undefined;
}

export default function readerExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "fetch_page",
    label: "Fetch Page",
    description: "Fetch a webpage and return its content in reader mode (clean text, no CSS/JS/ads).",
    parameters: Type.Object({
      url: Type.String({ description: "URL of the page to fetch" }),
      raw: Type.Optional(Type.Boolean({ description: "Return raw HTML instead of reader mode" })),
      max_length: Type.Optional(Type.Number({ description: "Max characters to return (default: 50000)" })),
    }),
    async execute(_toolCallId, params) {
      const { url, raw, max_length } = params;
      const maxLength = max_length ?? 50000;

      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; pi-reader/1.0)",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          redirect: "follow",
          signal: AbortSignal.timeout(15000),
        });

        if (!response.ok) {
          return { content: [{ type: "text" as const, text: `Error: HTTP ${response.status}` }] };
        }

        const html = await response.text();

        if (raw || !response.headers.get("content-type")?.includes("html")) {
          const out = html.length > maxLength ? html.slice(0, maxLength) + "\n\n[truncated]" : html;
          return { content: [{ type: "text" as const, text: out }] };
        }

        const title = extractTitle(html);
        const desc = extractDescription(html);
        const readable = htmlToReadable(extractMainContent(html));

        let result = "";
        if (title) result += `# ${title}\n\n`;
        if (desc) result += `> ${desc}\n\n`;
        result += readable;

        const out = result.length > maxLength ? result.slice(0, maxLength) + "\n\n[truncated]" : result;
        return { content: [{ type: "text" as const, text: out }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: `Error fetching ${url}: ${msg}` }] };
      }
    },
  });
}
```

## Why This Matters

A typical documentation page is 50-200KB of HTML. After stripping:

| What | Tokens (~) |
|------|-----------|
| Raw HTML | 15,000-60,000 |
| Reader mode | 1,000-5,000 |

That's a 10-30x reduction. With a 200K context window, raw HTML means you can read ~3-10 pages before hitting limits. Reader mode gets you 40-200 pages worth of headroom.

The conversion is lossy — you lose layout, images (except alt text), and interactive elements. But for reading documentation, articles, and reference material, the text content is all the agent needs.

## Next Steps

- The extension lives at `~/.pi/agent/extensions/reader.ts` — it loads globally for all projects
- Adjust `max_length` per call if you need more or less of a long page
- For pages that need JavaScript rendering (SPAs), you'd need a headless browser extension instead — this only fetches static HTML
