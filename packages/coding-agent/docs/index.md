# Pi Documentation

Pi is a minimal terminal coding harness. It is designed to stay small at the core while being extended through TypeScript extensions, skills, prompt templates, themes, and pi packages.

## Quick start

Install pi with npm:

```bash
npm install -g @mariozechner/pi-coding-agent
```

And run it:

```bash
pi
```

Authenticate with `/login` for subscription providers, or set an API key such as `ANTHROPIC_API_KEY` before starting pi.

Once you are signed in, you can ask pi about itself and it will answer you.  No
need to read the docs yourself ;-)

## Start here

- [Providers](/docs/latest/providers) - subscription and API-key setup for built-in providers.
- [Settings](/docs/latest/settings) - global and project settings.
- [Keybindings](/docs/latest/keybindings) - default shortcuts and custom keybindings.
- [Sessions](/docs/latest/session) - session storage format and session files.
- [Session tree](/docs/latest/tree) - branching and navigating previous turns.
- [Compaction](/docs/latest/compaction) - context compaction and branch summarization.

## Customization

- [Extensions](/docs/latest/extensions) - TypeScript modules for tools, commands, events, and custom UI.
- [Skills](/docs/latest/skills) - Agent Skills for reusable on-demand capabilities.
- [Prompt templates](/docs/latest/prompt-templates) - reusable prompts that expand from slash commands.
- [Themes](/docs/latest/themes) - built-in and custom terminal themes.
- [Pi packages](/docs/latest/packages) - bundle and share extensions, skills, prompts, and themes.
- [Custom models](/docs/latest/models) - add model entries for supported provider APIs.
- [Custom providers](/docs/latest/custom-provider) - implement custom APIs and OAuth flows.

## Programmatic usage

- [SDK](/docs/latest/sdk) - embed pi in Node.js applications.
- [RPC mode](/docs/latest/rpc) - integrate over stdin/stdout JSONL.
- [JSON event stream mode](/docs/latest/json) - print mode with structured events.
- [TUI components](/docs/latest/tui) - build custom terminal UI for extensions.

## Platform setup

- [Windows](/docs/latest/windows)
- [Termux on Android](/docs/latest/termux)
- [tmux](/docs/latest/tmux)
- [Terminal setup](/docs/latest/terminal-setup)
- [Shell aliases](/docs/latest/shell-aliases)

## Development

- [Development](/docs/latest/development) - local setup, project structure, and debugging.
