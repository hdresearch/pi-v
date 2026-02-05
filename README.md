# pi-v

Pi extensions and skills for [Vers](https://vers.sh) VM management and development workflows.

## Install

```bash
pi install git@github.com:hdresearch/pi-v.git
```

## What's included

### Extensions

| Extension | Description |
|-----------|-------------|
| `vers-vm` | Create, branch, commit, restore, and manage Vers VMs. Provides `vers_vm_*` tools. |
| `vers-swarm` | Spawn and orchestrate agent swarms across branched VMs. Provides `vers_swarm_*` tools. |
| `browser` | Headless Chrome browser automation (navigate, click, type, screenshot, eval). |
| `background-process` | Run and manage long-lived background processes (dev servers, watchers). |
| `plan-mode` | Structured plan-then-execute workflow mode. |

### Skills

| Skill | Description |
|-------|-------------|
| `vers-golden-vm` | Bootstrap a Vers VM into a golden image with pi, Node.js, and dev tools. |
| `vers-platform-development` | Guidelines for Vers platform development and issue reporting. |
| `investigate-vers-issue` | Deep investigation and debugging of Vers platform issues. |

## Dependencies

The `browser` extension requires `puppeteer`. After installing the package, run:

```bash
cd ~/.pi/agent/git/github.com/hdresearch/pi-v/extensions/browser
npm install
```
