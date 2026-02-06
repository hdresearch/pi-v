# browser-connect

Zero-friction Chrome browser control for pi agents. No Chrome extension needed.

Connects to your **real Chrome** — with all your logged-in sessions, cookies, and profiles — via Chrome DevTools Protocol (CDP). Powered by [agent-browser](https://github.com/vercel-labs/agent-browser).

## Setup

```bash
# Install agent-browser (one-time)
npm install -g agent-browser && agent-browser install
```

That's it. No Chrome extension. No configuration.

## Usage

```
You: "go check my GitHub PRs"

Agent calls: browser_launch
  → Connects to your Chrome via CDP (restarts with debug port if needed)
  → All your logged-in sessions are available

Agent calls: browser_go url="https://github.com/pulls"
  → Already authenticated — no login flow

Agent calls: browser_snapshot
  → Gets accessibility tree:
     - link "Fix billing webhook race condition" [ref=e3]
     - link "Add cancellation_scheduled status" [ref=e4]

Agent calls: browser_click ref="@e4"
  → Opens the PR
```

## Choosing a Profile

Chrome supports multiple profiles. Specify by display name, directory name, or email:

```
browser_launch profile="Work"
browser_launch profile="Profile 3"
browser_launch profile="me@company.com"
```

Or set a default via flag:
```bash
pi --chrome-profile "Work" ...
```

List profiles with the `/browser` command in pi.

## Tools

| Tool | What it does |
|------|-------------|
| `browser_launch` | Connect to Chrome (or launch with CDP + your profile) |
| `browser_go` | Navigate to URL |
| `browser_snapshot` | Get accessibility tree with refs (primary "see" tool) |
| `browser_click` | Click by ref (`@e2`) or CSS selector |
| `browser_type` | Type text into element |
| `browser_fill` | Clear + fill input |
| `browser_press` | Press keyboard key (Enter, Tab, Escape, etc.) |
| `browser_screenshot` | Save screenshot to file |
| `browser_read` | Get text/html/value/title/url |
| `browser_tabs` | List or switch tabs |
| `browser_wait` | Wait for element/text/url/load state |
| `browser_eval` | Run JavaScript in page |
| `browser_scroll` | Scroll page |
| `browser_find` | Semantic find (by role, text, label) + action |
| `browser_close` | Disconnect (browser stays open) |

## How it works

```
pi agent
  → browser_launch
    → Is Chrome running with CDP? Connect.
    → Chrome running without CDP? Gracefully restart with --remote-debugging-port=9222
    → Chrome not running? Launch with your profile + CDP
  → agent-browser CLI handles the actual automation via CDP
  → Your real Chrome, your real sessions, your real cookies
```

## vs Claude Code Browser

| | Claude Code | browser-connect |
|---|---|---|
| Setup | Install Chrome extension | `npm i -g agent-browser` |
| Profile access | Via extension (limited) | Full — your actual Chrome |
| Capabilities | DOM reading, basic clicks | Full CDP — screenshots, JS eval, network, tabs |
| Mid-session | Must be pre-installed | Connect anytime |
| Disconnect | N/A | Browser stays open, all tabs intact |
| Headed | N/A | You see everything in your browser |
