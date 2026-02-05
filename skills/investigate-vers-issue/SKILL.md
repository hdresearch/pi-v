---
name: investigate-vers-issue
description: Deep investigation of Vers platform issues (API, orchestrator, agent, docs). Use when encountering any Vers platform problem that needs thorough debugging and issue reporting.
---

# Investigate Vers Platform Issue

**You are in deep investigation mode** for a Vers platform issue.

## Your Mission

Thoroughly investigate a problem with the Vers platform (API, orchestrator, agent, documentation, etc.) and produce a comprehensive issue report.

## Investigation Checklist

### 1. Understand the Context

- [ ] What were you trying to accomplish?
- [ ] What Vers component is involved? (API, orchestrator, agent, docs, CLI)
- [ ] What did you expect to happen?
- [ ] What actually happened?

### 2. Reproduce Minimally

- [ ] Find the simplest way to trigger the issue
- [ ] Remove unnecessary steps/context
- [ ] Test with minimal inputs
- [ ] Document exact reproduction steps
- [ ] Verify it reproduces consistently

### 3. Gather Evidence

**For API Issues:**
- [ ] Exact HTTP request (curl command)
- [ ] Full response (status code, headers, body)
- [ ] API version/endpoint
- [ ] Authentication method used
- [ ] Try with different parameters
- [ ] Check API documentation (note what's missing/wrong)

**For Orchestrator Issues:**
- [ ] VM IDs involved
- [ ] Commands executed
- [ ] VM states at each step
- [ ] Check VM logs: `./scripts/vers-client.sh vm-exec <vmId> "tail -100 ~/.vers-agent/logs/vers-agent.log"`
- [ ] Check orchestrator logs (if accessible)
- [ ] Network connectivity tests

**For Agent Issues:**
- [ ] Agent version
- [ ] Full stack trace/error output
- [ ] Configuration files
- [ ] Environment variables
- [ ] Steps to reproduce from clean state

**For Documentation Issues:**
- [ ] What you searched for
- [ ] What you expected to find
- [ ] What you actually found (or link showing it's missing)
- [ ] Related but insufficient docs you found
- [ ] Examples that would have helped

### 4. Analyze Root Cause

- [ ] What's the underlying problem?
- [ ] Is this a bug, missing feature, or documentation gap?
- [ ] Why does this happen?
- [ ] What assumptions were incorrect?
- [ ] Is there a pattern of similar issues?

### 5. Explore Solutions

- [ ] What workarounds exist?
- [ ] What's the proper fix?
- [ ] Can you implement the fix?
- [ ] Should the API/design change?
- [ ] What would prevent this in the future?

### 6. Assess Impact

- [ ] Does this block work completely?
- [ ] Is there a workaround?
- [ ] How often would agents hit this?
- [ ] Does it affect external users or just internal?
- [ ] Is it a regression or longstanding issue?

### 7. Create Issue Report

Use this template:

```markdown
## Vers Platform Issue: [Brief Description]

**Component**: [API endpoint / CLI tool / Documentation / etc.]
**Severity**: [Critical / High / Medium / Low]
**Affects**: [Internal agents / External users / Both]

### Summary

[2-3 sentence summary of the issue]

### What I Was Trying To Do

[Describe the task/goal in context]

### What Went Wrong

[Specific problem encountered - be precise]

### Expected Behavior

[What should have happened based on docs/reasonable assumptions]

### Actual Behavior

[What actually happened - include evidence]

### Minimal Reproduction

```bash
# Exact steps to reproduce the issue
[Commands that trigger the issue]
```

**Expected output:**
```
[What you expected to see]
```

**Actual output:**
```
[What you actually got - exact error messages, responses, etc.]
```

### Evidence Gathered

**API Request/Response** (if applicable):
```bash
curl -X POST https://vers.sh/v1/endpoint \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"param": "value"}'

# Response:
HTTP/1.1 500 Internal Server Error
{}
```

**Logs** (if applicable):
```
[Relevant log excerpts]
```

### Root Cause Analysis

**Why this happens:**
[Your analysis of the underlying cause]

**Related issues:**
[Links to similar issues if you found any]

### Workaround

**Current workaround:**
```bash
[How you got past it, even if hacky]
```

**Workaround limitations:**
- [Any downsides or incompleteness of the workaround]

### Proposed Solution

**Immediate fix:**
[What would fix this right now]

**Proper fix:**
[What the right long-term solution is]

### Impact Assessment

- [ ] **Blocks work completely** - No workaround exists
- [ ] **Requires workaround** - Can proceed but hacky/inefficient
- [ ] **Confusing but workable** - Causes delay but not blocking
- [ ] **Documentation only** - Code works, docs are wrong/missing

**Frequency estimate:**
[How often would agents/developers hit this?]

### Agent Experience Note

**How this affected agent workflow:**
[Describe the friction this created for you as an agent]

**What would have made this easier:**
[Documentation, error messages, API design changes, etc.]

### Metadata

- **Discovered by**: [Agent session ID or developer name]
- **Date**: [When you found this]
- **Vers version**: [If known]
- **Environment**: [Local / VM / Production]
- **Related PRs/Issues**: [Links if any]
```

### 8. Decide Next Steps

After creating the issue:

**Options:**
1. **Implement the fix yourself** - If you can identify code changes needed
2. **Continue with workaround** - Document it and move on to main task
3. **Escalate** - If critical and blocking, notify team immediately
4. **Investigate further** - If root cause unclear, dig deeper

**Ask the user:**
"I've documented the issue in detail. Would you like me to:
- Implement a fix (estimated: X hours)
- Use the workaround and continue with main task
- Investigate the root cause further
- Something else?"

---

## Investigation Tools

### For API Issues

```bash
curl -v -X POST https://vers.sh/v1/endpoint \
  -H "Authorization: Bearer $VERS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"test": "data"}'

gh issue list --repo hdresearch/vers-api --search "keywords"
```

### For Orchestrator Issues

```bash
./scripts/vers-client.sh vms
./scripts/vers-client.sh vm-status
./scripts/vers-client.sh vm-exec <vmId> "tail -100 ~/.vers-agent/logs/vers-agent.log"
./scripts/vers-client.sh vm-exec <vmId> "curl -s http://localhost:80/health"
./scripts/vers-client.sh vm-outputs <vmId> 50
```

### For Agent Issues

```bash
vers-agent --version
tail -100 ~/.vers-agent/logs/vers-agent.log
curl http://localhost:80/health
cat ~/.vers-agent/config.json
```

### For Documentation Issues

```bash
open https://vers.sh/docs
gh issue list --repo hdresearch/vers-docs --search "documentation"
```

---

## Communication Pattern

As you investigate, keep the user informed:

**Initial**: "Starting deep investigation of [issue]. This will take ~15-30 minutes."
**Progress updates**: "Found: [discovery]. Testing: [hypothesis]."
**When blocked**: "Need [information/access/clarification] to continue."
**Completion**: "Investigation complete. Created issue [link]. Recommend: [next steps]."

---

## Success Criteria

A good investigation produces:
- Clear, reproducible issue report
- Minimal reproduction steps
- Evidence gathered and documented
- Root cause analysis (if possible)
- Workaround documented (if exists)
- Proposed solution outlined
- Impact assessed
- Next steps clear
