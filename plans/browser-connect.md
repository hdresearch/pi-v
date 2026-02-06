---
created: 2026-02-06 01:50
status: draft
---

# browser-connect: Zero-friction browser control for pi agents

## The Problem

Claude Code's browser access requires installing a Chrome extension. That's weak. Other tools launch a fresh Chromium with no sessions — useless for "go check my Jira." Engineers want to say "look at my PR on GitHub" and have the agent use their actual logged-in browser, mid-session, no setup.

## The Play

A pi extension that connects to the user's **real Chrome** via Chrome DevTools Protocol (CDP). No extension. No fresh browser. Your actual profile with all your logged-in sessions, cookies, saved passwords. Powered by [agent-browser](https://github.com/vercel-labs/agent-browser) CLI for the actual automation.

```
User: "go to my linear and find the bug I filed yesterday"
Agent: *connects to user's Chrome via CDP*
Agent: *already logged into Linear — no auth flow*
Agent: *reads the issues, finds the bug*
```

## Architecture

```
┌─────────────────────────────┐
│  pi extension               │
│  (browser-connect/index.ts) │
│  Registers tools:           │
│    browser_launch            │
│    browser_go               │
│    browser_snapshot         │
│    browser_click            │
│    browser_type             │
│    browser_screenshot       │
│    browser_tabs             │
│    browser_eval             │
│    browser_close            │
└──────────┬──────────────────┘
           │ spawns CLI commands
           ▼
┌──────────────────────────────┐
│  agent-browser CLI (Vercel)  │
│  --cdp 9222 --json           │
│  Handles CDP, Playwright,    │
│  snapshots, refs, selectors  │
└──────────┬───────────────────┘
           │ Chrome DevTools Protocol
           ▼
┌──────────────────────────────┐
│  User's actual Chrome        │
│  --remote-debugging-port=9222│
│  Real profile, real cookies, │
│  real sessions, real auth    │
└──────────────────────────────┘
```

## Connection Flow (the magic)

### `browser_launch` logic:

```
1. Is Chrome running?
   ├─ YES: Is debug port (9222) open?
   │   ├─ YES → connect via CDP. Done.
   │   └─ NO → Offer to relaunch Chrome with debug port:
   │       macOS: osascript -e 'tell app "Google Chrome" to quit'
   │              open -a "Google Chrome" --args --remote-debugging-port=9222
   │       linux: graceful kill + relaunch
   │       Chrome session restore brings back all tabs automatically.
   │       → connect via CDP. Done.
   └─ NO: Launch Chrome with user's profile + debug port
       macOS: open -a "Google Chrome" --args --remote-debugging-port=9222
       linux: google-chrome --remote-debugging-port=9222
       → connect via CDP. Done.
```

### Why this is better than Claude Code:
- **No extension install** — CDP is built into Chrome
- **Real profile** — your actual logged-in sessions, not a sandbox
- **Mid-session** — agent calls `browser_launch` whenever it needs a browser
- **Headed** — you SEE what the agent is doing in your actual Chrome
- **Disconnect ≠ close** — agent disconnects, your browser stays open

## Tools

| Tool | Description | agent-browser command |
|------|-------------|----------------------|
| `browser_launch` | Connect to Chrome or launch with profile + CDP | `connect 9222` |
| `browser_go` | Navigate to URL | `open <url>` |
| `browser_snapshot` | Accessibility tree with refs (AI-optimized) | `snapshot -i -c` |
| `browser_click` | Click by ref (@e2) or CSS selector | `click <sel>` |
| `browser_type` | Type into element | `type <sel> <text>` |
| `browser_fill` | Clear + fill input | `fill <sel> <text>` |
| `browser_screenshot` | Screenshot → temp file, return path | `screenshot <path>` |
| `browser_read` | Get text/html of element or page | `get text <sel>` / `get title` / `get url` |
| `browser_tabs` | List tabs, switch tab | `tab` (list) / `tab <n>` (switch) |
| `browser_wait` | Wait for element/text/url/networkidle | `wait <sel/ms/--text/--url>` |
| `browser_eval` | Run JS in page context | `eval <js>` |
| `browser_scroll` | Scroll page or element | `scroll <dir> [px]` |
| `browser_find` | Semantic find (role, text, label) + action | `find <type> <value> <action>` |
| `browser_close` | Disconnect from Chrome (browser stays open) | `close` |

### Key design: `browser_snapshot` is the primary "see" tool

The accessibility tree with refs is the most token-efficient way for an LLM to understand a page:
```
- heading "Linear — Pranav's Workspace" [ref=e1]
- navigation
  - link "Inbox" [ref=e2]
  - link "My Issues" [ref=e3]
  - link "Projects" [ref=e4]
- main
  - textbox "Search" [ref=e5]
  - list "Issues"
    - listitem
      - link "BUG-142: API returns 500 on empty payload" [ref=e6]
```

Agent sees this, calls `browser_click @e6`. Clean.

## File Structure

```
extensions/browser-connect/
├── package.json          # deps: (none — uses agent-browser CLI)
├── index.ts              # Main extension: registers all tools
├── chrome.ts             # Chrome detection, launch, relaunch
├── agent-browser.ts      # Wrapper to call agent-browser CLI
└── README.md
```

## Implementation Plan

### Phase 1: Core (MVP) — get it working
- [ ] `chrome.ts` — detect Chrome, check debug port, launch/relaunch with CDP
  - macOS: find Chrome binary, profile path, use `osascript` for graceful quit
  - Linux: `google-chrome` / `chromium-browser`, `xdg` profile paths
  - Port check: `lsof -i :9222` or `curl http://localhost:9222/json/version`
- [ ] `agent-browser.ts` — thin wrapper that shells out to `agent-browser` CLI
  - Handles `--cdp 9222 --json` flag injection
  - Parses JSON output
  - Error handling
- [ ] `index.ts` — register tools: `browser_launch`, `browser_go`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_fill`, `browser_screenshot`, `browser_close`
- [ ] `package.json` — metadata only (agent-browser installed globally)
- [ ] Test: manually verify connect → snapshot → click → type flow

### Phase 2: Full toolkit
- [ ] `browser_tabs` — list and switch tabs
- [ ] `browser_wait` — wait for element/text/URL/load
- [ ] `browser_eval` — run JS
- [ ] `browser_scroll` — scroll control
- [ ] `browser_find` — semantic locators (role, text, label)
- [ ] `browser_read` — get text/html/value/title/url
- [ ] `/browser` command — interactive browser dashboard in TUI

### Phase 3: Polish
- [ ] Auto-install `agent-browser` if not found (npm install -g agent-browser && agent-browser install)
- [ ] Streaming screenshots for live preview (AGENT_BROWSER_STREAM_PORT)
- [ ] Smart snapshot filtering: auto-compact for large pages
- [ ] Session persistence across pi restarts (remember CDP connection)
- [ ] Error recovery: auto-reconnect if Chrome restarts

## Chrome Profile Paths

### macOS
- Binary: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- Profile: `~/Library/Application Support/Google/Chrome`
- Launch: `open -a "Google Chrome" --args --remote-debugging-port=9222`
- Graceful quit: `osascript -e 'tell application "Google Chrome" to quit'`

### Linux
- Binary: `google-chrome` or `chromium-browser` (on PATH)
- Profile: `~/.config/google-chrome` or `~/.config/chromium`
- Launch: `google-chrome --remote-debugging-port=9222`
- Graceful quit: `kill -TERM $(pgrep -f 'chrome.*--type=browser')`

## CDP Port Detection

```bash
# Check if anything is listening on 9222
curl -s http://localhost:9222/json/version
# Returns: {"Browser":"Chrome/...","Protocol-Version":"1.3",...}

# Or check with lsof
lsof -i :9222 -sTCP:LISTEN
```

## Edge Cases

1. **Chrome running, no debug port, user declines relaunch** → Launch a NEW Chrome instance with debug port + user profile copy (read-only snapshot of profile, won't conflict with running Chrome)
2. **Multiple Chrome profiles** → Default to "Default" profile, flag `--chrome-profile` to pick
3. **Chrome Canary / Chromium / Brave** → Support via `--chrome-path` flag, auto-detect common paths
4. **Port 9222 already in use by something else** → Try 9223, 9224, etc.
5. **agent-browser not installed** → Auto-install on first `browser_launch`

## Why agent-browser over raw Puppeteer

1. **Snapshot with refs** — built-in accessibility tree, perfect for LLMs
2. **Session management** — handles CDP connection lifecycle
3. **CLI-based** — no need to manage Playwright/Puppeteer process lifecycle in-extension
4. **Active development** — Vercel-backed, good maintenance
5. **Cloud providers** — free Browserbase/Kernel/BrowserUse integration for remote browsers

## Why NOT a Chrome extension

| | Chrome Extension | CDP (our approach) |
|---|---|---|
| Install friction | Must install, trust, configure | Zero — CDP built into Chrome |
| Capabilities | Limited to extension APIs | Full browser control |
| Tab access | Can read DOM, limited automation | Full automation, screenshots, network |
| Profile access | Yes (same browser) | Yes (same browser) |
| Headless support | No | Yes |
| Works offline | Yes | Yes |
| Mid-session launch | No (must be pre-installed) | Yes (connect anytime) |

## Open Questions

1. **Windows support?** — Low priority but Chrome + CDP works the same. `start chrome --remote-debugging-port=9222`
2. **Firefox?** — Has its own remote debug protocol. Defer.
3. **Should `browser_screenshot` return base64 inline or save to file?** — File path probably better for large images. Could offer both.
4. **Rate limiting snapshots?** — Large pages can produce huge accessibility trees. Default to interactive-only (`-i`) + compact (`-c`)?
