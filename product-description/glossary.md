# Glossary

The vocabulary used across these documents. When a document uses one of these words, it means exactly this.

## The terminal

**Terminal.** The terminal emulator pi runs in. pi draws into it one frame at a time and reads keystrokes from it. Unless a document says otherwise, the terminal supports the Kitty keyboard protocol, so that Shift+Enter, Alt+Enter, and Ctrl+letter combinations arrive as distinct keys. Where a terminal does not, a document says what arrives instead.

**Width.** The number of columns the terminal currently has. Every line pi draws is wrapped or truncated to it. Width changes on resize and every component redraws.

**Scrollback.** The terminal's own history above pi's current frame. In the regular TUI mode the transcript grows into scrollback as it grows, and the user scrolls it with the terminal's own controls; pi does not own it.

**Regular mode.** The default TUI mode: pi draws on the terminal's main screen, the transcript flows into scrollback, and the bottom of the screen holds the pending area, status line, editor, and footer. The alternative, *fullscreen mode*, is out of scope.

**Kitty keyboard protocol.** The way a modern terminal reports every key with its modifiers unambiguously. pi asks for it at startup; when the terminal agrees, Shift+Enter, Ctrl+Enter, Alt+Enter, and Ctrl+letter combinations are distinct keys. When it does not, pi falls back to xterm's modifyOtherKeys reporting, and in terminals with neither, Shift+Enter and Ctrl+Enter are indistinguishable from Enter. Which terminals support what is in [the terminal](cross-cutting/the-terminal.md).

**Hardware cursor.** The terminal's own blinking cursor. pi hides it and draws its own inside the editor, but keeps the hidden one positioned at the editor's cursor so input-method candidate windows appear in the right place. The `showHardwareCursor` setting (or `PI_HARDWARE_CURSOR=1`) makes it visible for terminals that need that.

**Inline image.** A picture drawn inside a tool box when the model reads an image file, in terminals that can draw pictures (Kitty, Ghostty, WezTerm, Warp, iTerm2) and when `terminal.showImages` is on. Elsewhere, and always inside tmux, a placeholder line `[Image: path [image/png] WxH]` stands in for it.

## The screen

**Header.** The block at the top of a fresh session: the `pi v…` logo, the shortcut hints, and the loaded-resources listing. Collapsed by default; Ctrl+O expands it along with tool output.

**Transcript.** The list of everything that has happened in the session, in order: user messages, assistant messages, tool calls and their results, shell command boxes, status lines, errors, notices, and summaries. It is rebuilt from the session whenever the session's active position changes.

**Pending area.** The strip between the transcript and the status line that shows queued messages (`Steering: …`, `Follow-up: …`) and, while the agent is working, shell command boxes started during the turn.

**Status line.** The single spinner line above the editor that says what the agent is doing: `Working...`, `Retrying (2/3) in 4s...`, `Compacting context...`, `Summarizing branch...`. Empty when the agent is idle.

**Editor.** The bordered multi-line text box the user types into. Its border colour shows the thinking level, or the bash-mode colour when the text starts with `!`. Overlays replace it; when they close it returns with its text intact.

**Footer.** The one or two dim lines at the very bottom: the working directory (with `~` for home), the git branch, the session name; then token counts, cost, context usage, and the current model and thinking level.

**Overlay.** A selector or dialog that takes the editor's place and keyboard focus until it is accepted or dismissed: the model selector, the settings panel, the session picker, the tree, the login dialog, and the rest. Only one overlay is open at a time. Escape dismisses every overlay.

**Login dialog.** The overlay that `/login` ends in once a provider is chosen: a panel titled `Login to <provider>` that the provider's sign-in fills step by step with a hyperlinked URL, a device code, progress lines, or an input line for a key or a pasted code. It only grows; Escape abandons the whole sign-in. The two selectors that lead to it (the authentication method and the provider) are ordinary overlays.

**Submenu.** A second-level list opened from a row of the settings panel with Enter and drawn in the panel's place: the Warnings list, the per-model thinking steps, the Theme list. Escape in a submenu goes back one level rather than closing the panel; a choice made in a submenu is applied and saved the moment it is made, like any other panel change.

**Theme.** The named set of colours pi draws with. Two are built in, `dark` and `light`; the `theme` setting names one, and when the setting is absent pi detects the terminal's background at startup and picks one. A theme decides every colour role the user meets: message backgrounds, tool box tints, the thinking-level border ramp, the bash-mode green, diff and markdown colours, the spinner and selection accents. Custom theme files are out of scope.

**Theme pair.** A `theme` value written `light-name/dark-name` and offered as "Automatic" in the settings panel. pi uses the first half when the terminal reports a light appearance and the second when it reports dark, and switches between them while running when the terminal announces a change.

**Status message.** A dim one-line note added to the transcript, such as `Model: claude-…` or `Queued message for after compaction`. Consecutive status messages replace each other rather than piling up.

**Warning** and **error.** Transcript lines that begin `Warning:` (in the warning colour) or `Error:` (in the error colour). They stay in the transcript; they are not persisted to the session.

## The conversation

**Prompt.** The text the user submits with Enter, plus any images attached to it. Becomes a *user message* once sent.

**User message.** A prompt that has been sent. Shown in the transcript in the user-message background and written to the session.

**Assistant message.** One response from the model: text, thinking, and tool calls, in the order they arrived. A turn may contain several assistant messages, one per model call.

**Tool call.** A request by the model to run one of its tools (`read`, `bash`, `edit`, `write`; `grep`, `find`, `ls` when enabled). Shown as a box in the transcript that first shows the call, then its result. A *tool result* is the message carrying the outcome back to the model.

**Thinking.** The model's reasoning text, when the model produces it. Shown in italics in the thinking colour, or collapsed to a single `Thinking...` line when hidden with Ctrl+T.

**Thinking level.** How much reasoning the model is asked to do: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. The default is `medium`, clamped to what the model supports. Shown in the footer and as the editor border colour.

**Shell command.** A line beginning with `!` (or `!!`) that runs in the project's shell instead of going to the model. Its record is a *shell record* in the session; a `!!` record is hidden from the model.

**Bash mode.** The editor state while the text starts with `!`: the border turns the bash-mode colour (green in both built-in themes) and Escape clears the editor instead of its usual action.

**Initial prompt.** A prompt given on the command line instead of typed: the text of `pi "message"`, with the contents of any `@file` arguments in front of it and any images among them attached. It is sent as the first turn as soon as startup finishes, without the user pressing Enter, and is otherwise an ordinary prompt. Further messages on the command line are sent as further turns, one after another.

## The turn

**Turn.** The unit of interaction: one prompt sent and everything that follows until the agent settles. A turn contains one or more assistant messages and any tool calls between them; it ends when the model stops without calling a tool and nothing is queued, or when it is aborted, or when it fails for good.

**Idle.** The agent has no turn in progress. The status line is empty and Enter sends a new prompt.

**Working.** A turn is in progress: the model is being called, text is streaming, or tools are running. The status line shows `Working...`. Enter queues a steering message instead of sending.

**Sent.** The moment a prompt is committed: it is appended to the session and shown in the transcript before the model is called. It cannot be unsent; aborting leaves it in place.

**Streaming.** The part of working during which the model's text arrives piece by piece and the assistant message grows in the transcript.

**Settled.** The moment a turn is fully over, including any retries, auto-compaction, and queued continuations. Only then is the agent idle again. The difference between a model call ending and the turn settling matters when a retry or compaction follows.

**Abort.** Stopping a turn with Escape. The partial assistant message is kept and marked aborted, running tools are stopped and their results recorded as `Operation aborted`, queued messages are returned to the editor, and the agent settles.

**Retry.** An automatic second attempt after a transient provider error (overloaded, rate limited, network dropped): up to 3 attempts with 2, 4, and 8 second waits. The status line counts down; Escape cancels it.

**Steering message.** A message submitted with Enter while the agent is working. Delivered after the current assistant message and its tool calls finish, before the next model call, so the model sees it mid-task. By default one steering message is delivered per model call.

**Follow-up message.** A message submitted with Alt+Enter while the agent is working. Delivered only when the agent would otherwise stop. By default one follow-up is delivered at a time.

**Queue.** The pending steering and follow-up messages together. Alt+Up empties it back into the editor; Escape does the same and aborts.

**Holding queue.** Where a submission goes while compaction or branch summarization is running: Enter and Alt+Enter add to it with the status message `Queued message for after compaction`, and its entries are listed in the pending area like the queue's. When the compaction ends it is flushed: if the interrupted turn is about to be retried, its messages become steering and follow-up messages for that retry; otherwise the first becomes a new prompt and the rest are queued behind it. Alt+Up and Escape return it to the editor together with the queue.

## Sessions

**Session.** One conversation, stored as one file under `~/.pi/agent/sessions/` in a directory named after the working directory. A session remembers its messages, the model and thinking level in use, its name, and its tree of branches.

**Session file.** The JSONL file for a session. It is created when the first assistant message arrives, not when the session starts; a session that never got a response leaves no file.

**Ephemeral session.** A session started with `--no-session`. Everything works the same on screen but nothing is written to disk, and there is no resume hint on exit.

**Entry.** One line in a session file: a message, a model change, a thinking-level change, a name change, a label, a compaction, or a branch summary. Each entry points at its parent, so the file is a tree.

**Active position.** The entry the conversation currently continues from: the newest entry on the current branch. `/tree` moves it; everything after it on other branches is still in the file but not in the model's context.

**Branch.** A path from the root entry to a leaf. Submitting a prompt after moving the active position backwards starts a new branch; the old one stays in the file.

**Branch summary.** A summary of the branch being left, generated when `/tree` moves to another branch and the user asks for one. It is attached at the new position so the model knows what was tried.

**Label.** A short name the user puts on an entry from `/tree` with Shift+L, shown as `[name]` before the entry in the tree and found with the `labeled-only` filter or by searching. Saved as a label entry in the session file the moment it is entered; cleared by saving an empty label. Labels are bookmarks for the user only; the model never sees them.

**Tree filter.** Which entries `/tree` lists. `default` hides bookkeeping entries (labels, model and thinking-level changes, the session title); `no-tools` also hides tool results; `user-only` lists only user messages; `labeled-only` lists only labelled entries; `all` lists everything. Toggled with Ctrl+D/T/U/L/A, cycled with Ctrl+O, and started from the `treeFilterMode` setting.

**Compaction.** Replacing the older part of the conversation with a generated summary so that the model's context fits. Automatic when context exceeds the window minus 16,384 reserved tokens; manual with `/compact`. The newest 20,000 tokens are kept verbatim. Nothing is removed from the session file; only what the model is sent changes.

**Cut point.** The message at which compaction divides the conversation: everything before it is summarised, everything from it onward is kept verbatim. Chosen by walking back from the newest message until about 20,000 tokens have accumulated, then taking the nearest user message, assistant message, shell record, or summary at or after that point; never a tool result. A cut at an assistant message splits a turn, and the earlier part of that turn is summarised separately.

**Context overflow.** A model call that fails, or silently degrades, because the context no longer fits the model's window: a provider error saying the prompt is too long, a response whose reported input exceeds the window, or a response cut off with no room left to generate. pi does not retry an overflow as a transient error; it compacts and repeats the call once.

**Context.** What the model is sent on each call: the system prompt, the messages since the last compaction (with the compaction summary in front), and the tool definitions. Its size as a share of the model's window is shown in the footer.

**Session name.** A display name set with `/name` or `--name`, shown in the footer and in the session picker.

**Resume hint.** The line `To resume this session: pi --session <id>` that pi prints below its last frame when it quits in an orderly way. It names the session file's id (and the session directory, when it is not the default one) so the same conversation can be reopened from the shell. It is not printed for an ephemeral session, for a session that never got a response and so has no file, or when pi's output is not a terminal.

**Session picker.** The overlay opened by `/resume`, and shown on a bare terminal by `pi -r`, that lists saved sessions one per line with a search field above them. It has a scope (`Current Folder` or `All`, toggled with Tab), a sort (`Threaded`, `Recent`, `Fuzzy`, cycled with Ctrl+S), and a name filter (Ctrl+N), and can rename (Ctrl+R) and delete (Ctrl+D) sessions in place. Enter resumes the selected session; Escape closes the picker.

**Parent session.** The session a fork or clone was made from, recorded by path in the new session's header. The session picker's Threaded sort nests a session under its parent. Sessions started with `/new` have no parent.

**Fork.** Copying the conversation up to, but not including, a chosen user message into a new session, and switching to it with that message's text back in the editor. Done with `/fork`, which opens the fork panel; at startup, `pi --fork <path|id>` copies a whole session file, every branch included, into the current project. The original session is not changed.

**Fork panel.** The overlay opened by `/fork`, titled `Fork from Message`, listing every user message in the session with `Message N of M` under each. Up and Down move (wrapping), Enter forks at the selection, Escape closes it.

**Clone.** Copying the conversation up to the active position, inclusive, into a new session and switching to it with an empty editor: `/clone`. The transcript looks the same afterwards; only the file is new. The original session is not changed.

## Input

**Key.** One keystroke as pi decodes it, with modifiers: `enter`, `shift+enter`, `ctrl+c`, `alt+up`. Keybindings map keys to actions and can be changed in `~/.pi/agent/keybindings.json`; these documents describe the defaults.

**Submit.** Pressing Enter in the editor. The text is trimmed and handed to the submit handler, which decides whether it is a slash command, a shell command, a queued message, or a prompt.

**Slash command.** A line beginning with `/` that pi handles itself: `/model`, `/settings`, `/tree`, `/quit`, and the rest. Built-in slash commands run immediately, even while the agent is working. A `/` line pi does not recognise is sent to the model as text.

**Autocomplete popup.** The list that appears under the editor when typing `/` at the start of a line, `@` at a word boundary, or pressing Tab on a path. Up and Down move, Tab or Enter accept, Escape dismisses.

**Prompt history.** The last 100 submitted lines, browsed with Up and Down from the edges of the editor text. Kept in memory for the current run only.

**Double press.** Two presses of the same key within 500 ms: Ctrl+C twice quits; Escape twice on an empty editor opens the tree. The window is measured from the first press.

**Paste.** Text arriving from the terminal's bracketed paste, including dropped file paths. A paste longer than 10 lines or 1,000 characters is collapsed into a `[paste #1 +42 lines]` marker that expands on submit.

**Clipboard.** The operating system's clipboard, reached by pi through the platform's tools (`pbcopy`/`pbpaste` on macOS, `clip` on Windows, `wl-copy`/`wl-paste`, `xclip`, or `xsel` on Linux, `termux-clipboard-set` on Termux) and, over SSH, through the terminal's OSC 52 clipboard escape. Ctrl+X and `/copy` write it; Ctrl+V (Alt+V on Windows) reads it. pi has no clipboard of its own and no selection; see [clipboard](cross-cutting/clipboard.md).

## Events that end or interrupt a turn

**Cancel.** The user's explicit abort: Escape. While working it aborts the turn; while a shell command runs it kills the command; while an overlay is open it dismisses the overlay; in bash mode it clears the editor.

**Complete.** An event that ends an interaction cleanly and commits its result: the model stopping without a tool call, a shell command exiting, Enter in an overlay.

**Interrupt.** Something other than the user ending a turn: a provider error, a lost connection, a context overflow, the process being killed. What is kept after each is stated in every document's cancel-and-interrupt table.

**Transient error.** A provider or network failure that pi treats as worth retrying: the provider is overloaded or rate-limiting, returned a 5xx or 429 status, the connection was refused, reset, or lost, the name lookup failed, the request timed out, or the stream ended before its end marker. Decided by matching the error text against a fixed list; an error that matches neither the transient list nor the quota list is not retried. Quota, billing, balance, and usage-limit errors are never transient, whatever else their text says.

**Switch.** Replacing the current session with another (`/new`, `/resume`, `/fork`, `/clone`, `/import`, `/tree` to another branch). A switch aborts any turn in progress, flushes what was aborted into the old session, and drops the queue.

**Quit.** The user's orderly exit from pi: `/quit`, Ctrl+D on an empty editor, or Ctrl+C twice within 500 ms. A quit stops drawing, restores the terminal, aborts whatever the session was doing (a turn, a retry countdown, a compaction, a shell command), prints the resume hint, and exits with status 0. An exit caused by a signal, a dead terminal, or a crash is not a quit; those are in [process lifecycle](cross-cutting/process-lifecycle.md).

## Models and credentials

**Provider.** A vendor or endpoint pi can talk to: Anthropic, OpenAI, Google, GitHub Copilot, and the rest. Each has its own way of authenticating and its own list of models.

**Model.** One `provider/id` pair. The current model is shown at the right of the footer. Changed with `/model`, Ctrl+L, or Ctrl+P; the choice is recorded in the session and, with Ctrl+S in the selector, as the default.

**Default model.** The model saved as `defaultProvider` and `defaultModel` in the global settings, written by Ctrl+S in the model selector or by a login that selects a model when none was selected. It is the startup model when no session model applies and it is available; it is marked ` · default` in the model selector. Enter in the selector and Ctrl+P change the session's model without touching it.

**Model catalogue.** The list of models pi knows for each provider: a built-in list, refreshed from the vendor in the background at startup, after `/login`, and whenever the model selector or `/scoped-models` opens, with a 15-second limit. A refresh that fails leaves the cached list in use and says so inline (`showing cached models`). The product's own wording is `model catalogs`.

**Scoped models.** The subset of models that Ctrl+P cycles through, set with `--models` or `/scoped-models`. With no scope, Ctrl+P cycles every available model.

**Model scope.** The scoped models taken as a whole, in their order: "a scope exists" means scoped models are set, "no scope" means Ctrl+P cycles every available model. A scope is run state: it is resolved from `--models` or `enabledModels` at startup, edited live in `/scoped-models`, shown as the scoped list in the model selector, and never written to the session.

**Credential.** What authenticates a provider: an API key in an environment variable, or an entry in `~/.pi/agent/auth.json` written by `/login` (an API key or an OAuth token). A stored credential takes precedence over an environment variable for the same provider.

**Available model.** A model whose provider has a credential. Only available models can be selected; the footer shows no model when none is.

## Configuration

**Agent directory.** `~/.pi/agent/`, or `PI_CODING_AGENT_DIR` when set: settings, credentials, sessions, keybindings, trust decisions, downloaded tools, and installed packages all live under it.

**Settings.** `~/.pi/agent/settings.json` (global) and `.pi/settings.json` in the project (only when the project is trusted). Project settings override global settings key by key; command-line flags override both. `/settings` edits the global file.

**Working directory.** The directory pi was started in. Tools run there, context files are found by walking up from it, and the session is filed under it.

**Context files.** `AGENTS.md` (or `CLAUDE.md`, or `AGENTS.override.md`) found in the agent directory, in every ancestor of the working directory, and in the working directory itself, all added to the system prompt.

**Trust.** Whether pi may load a project's `.pi/` settings and resources. Asked once per project folder when such resources exist; remembered in `~/.pi/agent/trust.json`. A project with no `.pi/` directory is never asked.

**Trust prompt.** The question pi asks at startup, before the header is drawn, when the working directory has trust-requiring resources (`.pi/settings.json`, `.pi/extensions`, `.pi/skills`, `.pi/prompts`, `.pi/themes`, `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`, or a `.agents/skills` directory in the working directory or an ancestor) and no saved decision covers it: `Trust project folder?` with five options. It is distinct from the `/trust` overlay, which saves a decision for future runs without changing the current one.
