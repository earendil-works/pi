# Configuration

Pi supports user-level and project configuration. User-level configuration lives in the agent directory, which defaults to `~/.pi/agent`. Project configuration lives in `.pi` under the working directory and loads after [project trust](security.md#understand-project-trust) is granted.

In interactive mode, use `/settings` to change common preferences. For other options, ask Pi to update the configuration or edit the relevant files directly. Run `/reload` after manually changing settings, keybindings, instructions, or resources.

## Agent directory

The agent directory is shown as `<agent-dir>` below. Set its location with the `PI_CODING_AGENT_DIR` environment variable or the SDK's [`agentDir`](sdk.md) option.

| Path | Responsibility |
|---|---|
| `<agent-dir>/settings.json` | User-level [settings](settings-reference.md), including preferences, defaults, resource paths, and Pi package declarations. |
| `<agent-dir>/keybindings.json` | Custom terminal UI and application [keybindings](keybindings.md). |
| `<agent-dir>/models.json` | [Custom AI providers, endpoints, models, and model overrides](models.md). |
| `<agent-dir>/auth.json` | Saved API keys and OAuth credentials. |
| `<agent-dir>/AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, or `CLAUDE.MD` | User instructions applied across working directories. |
| `<agent-dir>/SYSTEM.md` | Replaces Pi’s default system prompt. |
| `<agent-dir>/APPEND_SYSTEM.md` | Adds instructions to Pi’s system prompt. |
| `<agent-dir>/extensions/` | User [extensions](extensions.md). |
| `<agent-dir>/skills/` | User [skills](skills.md) and supporting files. |
| `<agent-dir>/prompts/` | User [prompt templates](prompt-templates.md) exposed as slash commands. |
| `<agent-dir>/themes/` | User [theme](themes.md) files. |
| `<agent-dir>/sessions/` | Persistent sessions grouped by working directory. The session directory can be changed. |

## Project `.pi` directory

| Path | Responsibility |
|---|---|
| `.pi/settings.json` | Project-level [settings](settings-reference.md), resource paths, and Pi package declarations. |
| `.pi/SYSTEM.md` | Replaces the system prompt for the project. |
| `.pi/APPEND_SYSTEM.md` | Adds project-specific instructions to the system prompt. |
| `.pi/extensions/` | Project extensions. |
| `.pi/skills/` | Project skills and supporting files. |
| `.pi/prompts/` | Project prompt templates exposed as slash commands. |
| `.pi/themes/` | Project theme files. |

## Context files

Context files are separate from project `.pi` configuration. Pi loads one context file from the agent directory, followed by one from each directory between the filesystem root and the working directory. This means an `AGENTS.md` in a repository root also applies when Pi runs from a nested directory.

An `AGENTS.override.md` replaces `AGENTS.md` or `CLAUDE.md` only in the same directory. It does not suppress context files from the agent directory or other directories.

Context-file discovery does not require project trust.
