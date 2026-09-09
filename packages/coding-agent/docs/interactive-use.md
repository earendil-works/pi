# Pi in the Terminal

Interactive mode lets you prompt Pi, follow its tool calls, and change direction while it works. Start it from the project you want Pi to use:

```bash
cd /path/to/project
pi
```

The working directory determines which project configuration and context Pi discovers. Pi may ask you to trust project-local resources before loading them. See [Security](security.md#project-trust).

## Read the interface

<p align="center"><img src="images/interactive-mode.png" alt="Pi interactive mode showing a conversation, editor, and status information" width="750"></p>

The interface has four main areas:

- The startup header lists loaded context files and resources.
- The transcript contains messages, tool calls, results, notifications, and errors.
- The editor accepts prompts and commands. Its border indicates the current thinking level.
- The footer shows the working directory, session, context usage, model, and accumulated usage and cost.

Press `Ctrl+O` to expand or collapse tool output. Press `Ctrl+T` to expand or collapse thinking blocks. Use `/hotkeys` to inspect the active shortcuts.

## Add input and context

Type `@` to search for a project file and add it to your message. Tab completes paths. You can also paste images or drag them into a compatible terminal.

Use `Shift+Enter` for a new line. Press `Ctrl+G` to edit a longer prompt in the configured external editor.

Prefix a command with `!` to run it and include its output in the conversation. Use `!!` when you want to run the command without sending its output to the model.

## Direct a running task

You do not need to wait for the current response to finish:

- Press `Enter` to queue a steering message. Pi delivers it after the current assistant turn and its tool calls finish.
- Press `Alt+Enter` to queue a follow-up. Pi delivers it after the current run settles.
- Press `Alt+Up` to return queued messages to the editor.
- Press `Escape` to abort the current run and return queued messages to the editor.

Windows Terminal reserves some Alt shortcuts. See [Terminal Setup](terminal-setup.md) for platform-specific alternatives.

## Use commands

Type `/` to search available commands. Pi includes commands for models, sessions, settings, credentials, exports, and resource management. Extensions, skills, and prompt templates can add more.

The main paths from interactive mode are:

- `/model` and `/thinking` change the current model behavior. See [Models and Providers](models-and-providers.md).
- `/resume`, `/tree`, `/fork`, and `/compact` manage conversation history. See [Sessions and Context](sessions-and-context.md).
- `/settings` changes common preferences. See [Configuration](configuration.md).
- `/reload` reloads extensions, skills, prompt templates, themes, keybindings, and context files.

See [CLI and Modes](cli.md) for the complete command-line and slash-command reference.

## Copy and export results

Press `Ctrl+X` to copy the last assistant response. In the tree view it copies the selected message. In fullscreen mode, it copies the active text selection when automatic copy-on-select is disabled.

Use `/export` to write the session as HTML or JSONL. Use `/share` to publish a private GitHub gist with a shareable viewer link. Review the session before sharing because it can contain prompts, tool output, file contents, and credentials exposed during the conversation.

## Choose a transcript mode

Regular mode uses the terminal's normal scrollback. Fullscreen mode keeps the editor and status area fixed while the transcript scrolls inside the terminal viewport.

Set the mode through `/settings` or `--tui-mode`. Terminal support for mouse input, keyboard shortcuts, and inline images varies. See [Terminal Setup](terminal-setup.md) before changing terminal-specific settings.

For every configurable shortcut, see [Keybindings](keybindings.md).
