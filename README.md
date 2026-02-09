# pi-v

Pi extensions and skills for [Vers](https://vers.sh) VM management and development workflows.

## Install

One-liner that checks for pi, installs it if needed, and sets everything up:

```bash
curl -fsSL https://raw.githubusercontent.com/hdresearch/pi-v/main/install.sh | bash
```

Or if you already have pi:

```bash
pi install git@github.com:hdresearch/pi-v.git
```

## What's included

### Extensions

| Extension | Description |
|-----------|-------------|
| `vers-vm` | Create, branch, commit, restore, and manage Vers VMs. Provides `vers_vm_*` tools. |
| `vers-swarm` | Spawn and orchestrate agent swarms across branched VMs. Supports multiple LLM providers (Anthropic, ZAI/GLM, Google, OpenAI, Azure). Provides `vers_swarm_*` tools. |
| `browser` | Headless Chrome browser automation (navigate, click, type, screenshot, eval). |
| `background-process` | Run and manage long-lived background processes (dev servers, watchers). |
| `plan-mode` | Structured plan-then-execute workflow mode. |

### Skills

| Skill | Description |
|-------|-------------|
| `vers-golden-vm` | Bootstrap a Vers VM into a golden image with pi, Node.js, and dev tools. |
| `vers-platform-development` | Guidelines for Vers platform development and issue reporting. |
| `investigate-vers-issue` | Deep investigation and debugging of Vers platform issues. |
| `contribute-fix` | Contribute bug fixes back to pi-v via fork/PR or issue. |

## Contributing

Found a bug? Have a fix? See [CONTRIBUTING.md](CONTRIBUTING.md). PRs welcome via the standard fork workflow.

### Swarm Providers

Swarm agents can run on any LLM provider supported by pi. When spawning a swarm, pass the `provider` and `apiKey` parameters:

| Provider | Name | Env Var | Example Model |
|----------|------|---------|---------------|
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-20250514` |
| ZAI/GLM | `zai` | `ZAI_API_KEY` | `glm-4.7` |
| Google | `google` | `GOOGLE_API_KEY` | `gemini-2.5-flash` |
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-4o` |
| Azure | `azure` | `AZURE_OPENAI_API_KEY` | — |

If no provider is specified, defaults to `anthropic`. Any provider not in this list will use `{PROVIDER_NAME}_API_KEY` as the env var.

## Dependencies

The `browser` extension requires `puppeteer`. After installing the package, run:

```bash
cd ~/.pi/agent/git/github.com/hdresearch/pi-v/extensions/browser
npm install
```

