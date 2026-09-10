# Configuration

Pi can configure saved preferences, model defaults, keybindings, themes, project instructions, and reusable resources. Start with `/settings` for common preferences. Edit configuration files for advanced options or behavior that should follow a project.

Changes made through `/settings` apply immediately. During an active session, run `/reload` after manually editing settings, keybindings, instruction files, or resource configuration. An active custom theme reloads automatically when its file changes. Saved model defaults apply to new sessions, and a decision saved with `/trust` applies after you restart Pi.

## Settings

Run `/settings` to change common options such as:

- theme and terminal display
- regular or fullscreen TUI mode
- steering and follow-up delivery
- automatic compaction
- project trust defaults

Changes made through `/settings` are saved to your global settings.

For options that are not available through `/settings`, edit one of these files:

| Location | Scope |
|---|---|
| `~/.pi/agent/settings.json` | Every project for the current user |
| `.pi/settings.json` | The current project after it is trusted |

Project settings override global settings. Nested setting objects are merged. Paths in global settings resolve from `~/.pi/agent`; paths in project settings resolve from `.pi`.

Use global settings for personal defaults. Use project settings only for behavior that should follow the repository. Project settings can load executable resources, so review [Project Trust](security.md#project-trust) before accepting them.

Model defaults use separate selectors. In `/model`, press `Ctrl+S` to save the selected startup model. In `/thinking`, press `Ctrl+S` to save the startup thinking level. See [Models and Providers](models-and-providers.md).

The complete setting names, types, defaults, and precedence rules are in [Settings](settings-reference.md).

## Keybindings

User keybindings live in `~/.pi/agent/keybindings.json`. Bind each namespaced action to one key or a list of keys.

Use `/hotkeys` to verify the active bindings. See [Keybindings](keybindings.md) for key syntax, action identifiers, defaults, and platform-specific behavior.

## Themes

Select a theme through `/settings`. Use `--use-theme` to choose the initial theme for one run without changing the saved setting.

Custom themes are JSON files. Put personal themes under `~/.pi/agent/themes/` or project themes under `.pi/themes/`. Start from a built-in theme, give it a unique name, and use the published JSON schema to validate its colors.

See [Themes](themes.md) for discovery rules, the schema, color formats, required tokens, and built-in examples.

## Instructions

Use `AGENTS.md` to give Pi project commands, conventions, and safety constraints. Pi loads a global file from `~/.pi/agent/AGENTS.md`, then context files from ancestor directories and the current working directory.

`AGENTS.override.md` replaces `AGENTS.md` or `CLAUDE.md` from the same directory. It does not suppress context files from other directories.

Use `.pi/SYSTEM.md` to replace Pi's default system prompt for a project, or `.pi/APPEND_SYSTEM.md` to append text. Global equivalents live under `~/.pi/agent/`. Replacing the system prompt is a stronger change than adding project instructions, so prefer `AGENTS.md` unless the default prompt itself must change.

Disable context-file discovery for one run with `--no-context-files`.

## Resources

Settings can load extensions, skills, prompt templates, themes, and Pi packages. Prefer each resource's conventional directory when possible. Explicit settings are useful for additional paths, glob filters, or package-level resource selection.

Project-local resources load only after project trust is granted. See [Extensions](extensions.md), [Skills](skills.md), [Prompt Templates](prompt-templates.md), and [Pi Packages](packages.md) for their discovery and packaging rules.

## Verify a change

Use the interface that owns the configuration:

- `/settings` shows common saved preferences.
- `/model` and `/thinking` show the current model controls.
- `/hotkeys` shows active shortcuts.
- The startup header reports discovered context and resources unless quiet startup is enabled.
