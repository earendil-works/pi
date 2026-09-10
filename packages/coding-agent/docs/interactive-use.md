# Use Pi in the terminal

Run `pi` from the folder you want to work in. Pi uses that folder to discover files, instructions, and configuration, and to group saved sessions. If you have not installed Pi or chosen a model yet, follow the [Quickstart](quickstart.md).

Pi may ask whether you trust the working folder before loading its project resources. See [Project trust](security.md#understand-project-trust).

<p align="center"><img src="images/interactive-mode.png" alt="Pi interactive mode showing a conversation, editor, and status information" width="750"></p>

The transcript shows your prompts, Pi's responses, tool calls, results, and errors. You write prompts and commands in the editor. The footer shows the current folder, session, model, context usage, and accumulated usage and cost.

## Enter a prompt

Type a request and press `Enter` to send it. Use `Shift+Enter` to add a line, or press `Ctrl+G` to work on a longer prompt in your configured external editor.

To include files or images:

- Type `@` to search for a file and add it to your prompt.
- Press `Tab` to complete a path.
- Paste an image or drag it into a compatible terminal.

## Follow Pi's work

Pi shows each tool call and result while it works. Press `Ctrl+O` to expand or collapse tool output. Press `Ctrl+T` to show or hide thinking blocks.

The startup header lists the instructions and resources Pi loaded. The editor border indicates the current thinking level. The footer updates as the model uses context and reports usage.

Pi does not ask before every tool call. Review commands and changed files, and use a sandbox for untrusted or unattended work. See [Security](security.md).

## Change direction

You can send more input while Pi is working:

| What you want | Action |
|---|---|
| Adjust the current task | Type a message and press `Enter` |
| Add work after the current task | Type a message and press `Alt+Enter` |
| Return queued messages to the editor | Press `Alt+Up` |
| Stop the current task | Press `Escape` |

A message sent with `Enter` waits until the current response and its tool calls finish, then guides the next response. A follow-up sent with `Alt+Enter` waits until Pi finishes the current task. Aborting returns queued messages to the editor.

Windows Terminal reserves some Alt shortcuts. See [Terminal Setup](terminal-setup.md) for the Windows alternatives.

## Change the model or settings

Type `/` to search the available commands. The commands you will use most often are:

- `/model` selects a model. Press `Ctrl+L` to open the same selector.
- `/thinking` selects how much reasoning the current model uses. Press `Shift+Tab` to cycle through supported levels.
- `/login` and `/logout` manage provider access.
- `/settings` changes common preferences.

Prompt templates, skills, and extensions can add more commands to the same menu. See [Choose a Model](models-and-providers.md), [Configuration](configuration.md), or the complete [Slash Commands reference](slash-commands.md).

## Continue or start over

Pi saves sessions automatically unless session persistence is disabled.

- `/new` starts a new session.
- `/resume` opens another saved session.
- `/name` gives the current session a recognizable name.
- `/session` shows its file, ID, message count, token usage, and cost.

Use `/tree`, `/fork`, or `/clone` when you want to explore another approach without losing existing work. Use `/compact` to reduce the conversation history sent to the model. See [Sessions and Context](sessions-and-context.md) for these workflows.

After leaving Pi, run `pi --continue` from the same folder to resume its most recent session.

## Run a terminal command

Prefix a command with `!` to run it and include its output in the conversation:

```text
!git status
```

Use `!!` when you want to run a command without sending its output to the model.

## Copy, export, or share results

Press `Ctrl+X` or run `/copy` to copy the last assistant response. Use `/export` to save the session as HTML or JSONL.

Use `/share` to upload the session and get a viewer link. With Radius authentication, the artifact is visible to your Radius organization. Otherwise, Pi creates a private GitHub gist through the GitHub CLI. Review the session first because it can contain prompts, tool output, file contents, and credentials exposed during the conversation.

## Adjust the terminal

Regular mode uses the terminal's normal scrollback. Fullscreen mode keeps the editor and status area fixed while the transcript scrolls within the terminal window. Choose a mode through `/settings` or `--tui-mode`.

Terminal support for mouse input, keyboard shortcuts, and inline images varies. See [Terminal Setup](terminal-setup.md) for platform-specific configuration and [Keybindings](keybindings.md) for every configurable shortcut. Run `/hotkeys` to inspect the shortcuts active in your current session.
