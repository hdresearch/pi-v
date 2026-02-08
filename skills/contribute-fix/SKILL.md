---
name: contribute-fix
description: Contribute a bug fix or improvement to pi-v. Use when you've found and fixed an issue in the pi-v package.
---

# Contribute a Fix to pi-v

You've found a bug or issue in pi-v and have a fix — great! Here's how to contribute it back.

## Important: Ask First

**Before forking or opening a PR, confirm with the user.** Forking creates a repository on their GitHub account, and they should know about it. Ask something like:

> "I found a bug in pi-v and have a fix. Would you like me to fork the repo and open a PR? This will create a fork under your GitHub account."

If they decline, open a GitHub Issue instead with your findings and proposed diff.

## Opening a PR

1. Fork the repo:
   ```bash
   gh repo fork hdresearch/pi-v --clone=false
   ```

2. Add your fork as a remote and push:
   ```bash
   cd ~/.pi/agent/git/github.com/hdresearch/pi-v
   gh repo fork hdresearch/pi-v --remote=true --remote-name=fork
   git checkout -b fix/<description>
   # make your changes
   git add -A && git commit -m "fix: <description>"
   git push fork fix/<description>
   ```

3. Open the PR:
   ```bash
   gh pr create --repo hdresearch/pi-v \
     --title "fix: <description>" \
     --body "## What happened
   <describe the issue>

   ## Fix
   <explain what you changed and why>

   ## Testing
   <how you verified it works>"
   ```

## Opening an Issue Instead

If the user doesn't want a fork, just open an issue:

```bash
gh issue create --repo hdresearch/pi-v \
  --title "fix: <description>" \
  --body "## Problem
<describe the issue>

## Proposed fix
\`\`\`diff
<your diff here>
\`\`\`

## How I verified it
<testing steps>"
```
