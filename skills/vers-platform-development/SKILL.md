---
name: vers-platform-development
description: Guidelines for Vers platform development. Agent Experience (AX) is a product metric - investigate ALL Vers issues (API, orchestrator, agent, docs) rather than silently working around them. Covers issue triage, reporting templates, and communication patterns.
---

# Vers Platform Development Guidelines

**Context**: You are working on the Vers platform or interacting with Vers APIs as a member of High Dimensional Research (HDR). These guidelines apply to ALL Vers-related development work.

---

## Critical: Agent Experience (AX) is Our Product

**Philosophy**: If an agent struggles with our platform, that's a product bug, not a user error.

We build tools for AI agents. When YOU (an agent) have trouble using our APIs, tools, or documentation, that represents a failure in our product. Your struggle is valuable signal about what needs fixing.

---

## Investigate ALL Vers Platform Issues

### When to Investigate

**ANY TIME you encounter:**
- Missing documentation for Vers APIs
- Incorrect/outdated documentation
- API errors or unexpected responses
- Confusing API design or parameters
- Need to guess at correct usage
- Workarounds required for basic functionality
- Tools/endpoints that appear broken
- Skills or context that should exist but don't
- Unclear error messages
- Difficult-to-debug failures

**Even if you find a workaround**: The fact that you hit the issue is our problem.

### Investigation Priority

**It is OKAY to get derailed** investigating seemingly "irrelevant" issues you could technically work past.

Why? Because:
1. Other agents (internal and customer) will hit the same issue
2. Fixing it improves our product for everyone
3. Your investigation time is an investment in platform quality
4. We're optimizing for agent experience, not just completion speed

### Investigation Process

When you encounter a Vers platform issue:

1. **Don't just work around it** - Investigate the root cause
2. **Reproduce minimally** - Find the simplest repro case
3. **Document thoroughly** - Capture exact steps, inputs, outputs
4. **Check existing issues** - Search GitHub/internal trackers first
5. **Create an issue report** - Use the investigate-vers-issue skill
6. **Inform the user** - Tell them you're investigating a platform issue
7. **Consider fixing it yourself** - If you can identify the fix, propose it

### What NOT to Do

- Don't silently work around Vers issues without reporting
- Don't assume it's "just you" or that you misunderstood
- Don't skip investigation because "it's not my main task"
- Don't accept poor error messages or missing docs as normal

---

## Specific Vers Components to Watch For

### Vers API (`vers.sh` / API endpoints)

**Common issues:** Undocumented endpoints/parameters, inconsistent response formats, unclear auth requirements, missing error details, rate limiting without clear headers.

**When you hit an issue**: Check API docs, try different approaches, document what doesn't work, create issue with curl reproduction.

### Vers Orchestrator (VM management)

**Common issues:** VM creation failures, unexpected VM states, SSH/connectivity problems, golden commit issues, resource cleanup failures.

**When you hit an issue**: Gather VM IDs, check logs via `vm-exec`, document exact orchestrator commands used.

### Vers Agent (`vers-agent` codebase)

**Common issues:** Build failures, runtime errors, configuration problems, dependency issues, agent protocol mismatches.

**When you hit an issue**: Include stack traces, exact versions, configuration files, and steps to reproduce.

### Vers Documentation

**Common issues:** Missing examples, outdated information, unclear explanations, broken links, gaps in coverage.

**When you hit an issue**: Note what you searched for, what you expected to find, what you actually found (or didn't).

---

## Issue Triage

**Where to file issues:**

| Component | Repository | Notes |
|-----------|------------|-------|
| Vers API | `vers-api` (internal) | API endpoint issues |
| Vers Orchestrator | `vers-orchestrator` | VM management issues |
| Vers Agent | `vers-agent` | Agent runtime issues |
| Vers Docs | `vers-docs` | Documentation gaps/errors |
| Agent Guidelines | `hdr-agent-guidelines` | Guidelines and context |

**Issue labels to use:**
- `agent-experience` - Issues that affect agent usability
- `documentation` - Missing/incorrect docs
- `api-design` - API usability issues
- `needs-repro` - Needs minimal reproduction steps
- `workaround-exists` - Blocking but has workaround
- `critical` - Blocks work completely

---

## Balancing Investigation vs Progress

- **Spend 15-30 minutes** investigating most issues
- **Spend more time** if the issue is severe or common
- **Create the issue even if you don't fully solve it** - Document what you learned
- **Inform the user** - "I'm investigating a platform issue that affects X, should take ~N minutes"
- **Ask for guidance** - "This seems like a deeper issue, should I continue investigating or file and move on?"

**Red flags that warrant deeper investigation:**
- Issue affects multiple developers/agents
- Core functionality is broken
- No workaround exists
- Error messages are cryptic
- Documentation is completely missing

---

## Communication Pattern

When you encounter a Vers issue:

1. **Acknowledge it**: "I'm encountering an issue with [Vers component]"
2. **Investigate**: Spend time debugging, checking docs, trying alternatives
3. **Report findings**: "Here's what I found: [summary]"
4. **File issue**: "I've created [issue link] with full details"
5. **Propose path forward**: "For now, I can [workaround]. Alternatively, I can [investigate further / fix it / wait for fix]."
