# Configuration

Pi supports user-level and project configuration. User-level configuration lives in the agent directory, which defaults to `~/.pi/agent`. Project configuration lives in `.pi` under the working directory and loads after [project trust](security.md#understand-project-trust) is granted.

In interactive mode, use `/settings` to change common preferences. For other options, ask Pi to update the configuration or edit the relevant files directly. Run `/reload` after manually changing settings, keybindings, instructions, or resources.

### Agent directory

The location of the agent directory storing user-level configuration can be specified using the `PI_CODING_AGENT_DIR` environment variable or directly when using the SDK.

| Path | Responsibility |
|---|---|
| `<agent-dir>/settings.json` | User-level preferences, defaults, resource paths, and Pi package declarations. |
| `<agent-dir>/keybindings.json` | Custom terminal UI and application [keybindings](keybindings.md). |
| `<agent-dir>/models.json` | Custom AI providers, endpoints, models, and model overrides. |
| `<agent-dir>/auth.json` | Saved API keys and OAuth credentials. |
| `<agent-dir>/AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, or `CLAUDE.MD` | User instructions applied across working directories. Pi loads the first matching file in this order. |
| `<agent-dir>/SYSTEM.md` | Replaces Pi’s default system prompt. |
| `<agent-dir>/APPEND_SYSTEM.md` | Adds instructions to Pi’s system prompt. |
| `<agent-dir>/extensions/` | User extensions. |
| `<agent-dir>/skills/` | User skills and supporting files. |
| `<agent-dir>/prompts/` | User prompt templates exposed as slash commands. |
| `<agent-dir>/themes/` | User [theme](themes.md) files. |
| `<agent-dir>/sessions/` | Persistent sessions grouped by working directory. The session directory can be changed. |

### Project `.pi` directory

Project configuration loads after project trust is granted.

| Path | Responsibility |
|---|---|
| `.pi/settings.json` | Project-level settings, resource paths, and Pi package declarations. |
| `.pi/SYSTEM.md` | Replaces the system prompt for the project. |
| `.pi/APPEND_SYSTEM.md` | Adds project-specific instructions to the system prompt. |
| `.pi/extensions/` | Project extensions. |
| `.pi/skills/` | Project skills and supporting files. |
| `.pi/prompts/` | Project prompt templates exposed as slash commands. |
| `.pi/themes/` | Project theme files. |

## Context files

Context files are separate from project `.pi` configuration. Pi loads one context file from the agent directory, followed by one from each directory between the filesystem root and the working directory. This means an `AGENTS.md` in a repository root also applies when Pi runs from a nested directory.

Within each directory, Pi uses the first available file in this order: `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, then `CLAUDE.MD`. An `AGENTS.override.md` replaces other context files only in the same directory. It does not suppress files from the agent directory or other directories.

Context-file discovery does not require project trust. Disable it for one run with `--no-context-files`.

## Related documentation

- [Settings](settings-reference.md)
- [Models and providers](models-and-providers.md)
- [Keybindings](keybindings.md)
- [Extensions](extensions.md)
- [Skills](skills.md)
- [Prompt templates](prompt-templates.md)
- [Themes](themes.md)
- [Pi packages](packages.md)
- [Sessions and context](sessions-and-context.md)
