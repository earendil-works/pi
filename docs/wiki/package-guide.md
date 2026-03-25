# Package Guide

This page tells you what each package is for and when a beginner should read it.

## Read these first

### `packages/coding-agent`

**What it is:** the main user-facing product in this repo.

**Why it matters first:** the root `README.md` explicitly points users here when they are looking for the coding agent.

**Read when:**

- you want to use pi,
- you want to understand sessions, commands, skills, extensions, or settings,
- you are changing CLI behavior.

**Start with:**

- `packages/coding-agent/README.md`
- `packages/coding-agent/docs/providers.md`
- `packages/coding-agent/docs/settings.md`
- `packages/coding-agent/docs/development.md`

### `packages/agent`

**What it is:** the reusable stateful agent runtime.

**Read when:**

- you need to understand event flow,
- tool execution order matters,
- you are debugging agent state, steering, follow-up, or retries.

**Start with:**

- `packages/agent/README.md`

### `packages/ai`

**What it is:** the unified LLM provider layer.

**Read when:**

- you are dealing with providers, models, auth, tool-call validation, usage accounting, or reasoning support,
- you want to add or debug provider behavior.

**Start with:**

- `packages/ai/README.md`

### `packages/tui`

**What it is:** the terminal UI toolkit used by the coding agent.

**Read when:**

- you are changing editor behavior,
- rendering glitches matter,
- keyboard handling, overlays, markdown rendering, or image display are involved.

**Start with:**

- `packages/tui/README.md`

## Read these when your work is specialized

### `packages/web-ui`

**What it is:** reusable browser UI components for chat interfaces built on the same agent stack.

**Read when:**

- you are working on browser UI,
- you need to understand how the agent is adapted to the web,
- storage, attachments, or CORS handling are relevant.

### `packages/mom`

**What it is:** a Slack bot built on the same ecosystem.

**Read when:**

- your task involves Slack integration,
- you care about sandboxing, channel memory, or operational security in bot workflows.

### `packages/pods`

**What it is:** a CLI for GPU pods and vLLM deployments.

**Read when:**

- your task is about remote inference infrastructure,
- model deployment, GPU allocation, or vLLM setup are involved.

## Fast package selection table

| If you need to change... | Start here |
|---|---|
| `pi` CLI behavior | `packages/coding-agent` |
| agent loop/tool lifecycle | `packages/agent` |
| model/provider/auth behavior | `packages/ai` |
| terminal rendering/input | `packages/tui` |
| browser chat UI | `packages/web-ui` |
| Slack bot behavior | `packages/mom` |
| GPU pod/vLLM deployment | `packages/pods` |

## One useful rule of thumb

If you are unsure where to start, begin with `packages/coding-agent` and trace downward into `agent` and `ai`. That matches how most beginners encounter the repo.
