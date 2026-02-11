# I need to read a web page

## Steps

1. Fetch in reader mode (strips CSS, JS, ads, nav — returns clean text):
```
fetch_page --url "https://example.com/docs/getting-started"
```

2. Output is markdown-like: headings as `#`, links as `text (url)`, lists as `- item`, code blocks preserved.

## If I need the raw HTML

```
fetch_page --url "https://example.com" --raw true
```

## If the page is too large

Default limit is 50,000 characters. Reduce it:
```
fetch_page --url "https://example.com" --max_length 10000
```

## What gets stripped

- `<script>`, `<style>`, `<noscript>`, `<svg>`, `<iframe>` — removed entirely
- `<nav>`, `<header>`, `<footer>`, `<aside>` — removed entirely
- Hidden elements (`display:none`, `aria-hidden`) — removed
- All remaining HTML tags — stripped, text kept

## What gets preserved

- Headings → `#`, `##`, `###`
- Links → `link text (url)`
- Images → `[image: alt text]`
- Lists → `- item`
- Code blocks → ``` fenced blocks
- Tables → tab-separated
- Title and meta description → shown at top

## Content extraction priority

The extension tries to find the main content area before converting:
1. `<article>` tag
2. `<main>` tag
3. `role="main"` attribute
4. `id="content"` or `class="content"` div
5. `class="post-content"` or `class="entry-content"` div
6. Falls back to `<body>`
