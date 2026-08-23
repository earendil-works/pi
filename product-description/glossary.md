# Glossary

The vocabulary used across these documents. When a document uses one of these words, it means exactly this.

## The terminal

**Terminal.** The terminal emulator pi runs in. pi draws into it one frame at a time and reads keystrokes from it. Unless a document says otherwise, the terminal supports the Kitty keyboard protocol, so that Shift+Enter, Alt+Enter, and Ctrl+letter combinations arrive as distinct keys. Where a terminal does not, a document says what arrives instead.

**Width.** The number of columns the terminal currently has. Every line pi draws is wrapped or truncated to it. Width changes on resize and every component redraws.

**Scrollback.** The terminal's own history above pi's current frame. In the regular TUI mode the transcript grows into scrollback as it grows, and the user scrolls it with the terminal's own controls; pi does not own it.

**Regular mode.** The default TUI mode: pi draws on the terminal's main screen, the transcript flows into scrollback, and the bottom of the screen holds the pending area, status line, editor, and footer. The alternative, *fullscreen mode*, is out of scope.

## The screen

**Header.** The block at the top of a fresh session: the `pi v…` logo, the shortcut hints, and the loaded-resources listing. Collapsed by default; Ctrl+O expands it along with tool output.

**Transcript.** The list of everything that has happened in the session, in order: user messages, assistant messages, tool calls and their results, shell command boxes, status lines, errors, notices, and summaries. It is rebuilt from the session whenever the session's active position changes.

**Pending area.** The strip between the transcript and the status line that shows queued messages (`Steering: …`, `Follow-up: …`) and, while the agent is working, shell command boxes started during the turn.

**Status line.** The single spinner line above the editor that says what the agent is doing: `Working...`, `Retrying (2/3) in 4s...`, `Compacting context...`, `Summarizing branch...`. Empty when the agent is idle.

**Editor.** The bordered multi-line text box the user types into. Its border colour shows the thinking level, or the bash-mode colour when the text starts with `!`. Overlays replace it; when they close it returns with its text intact.

**Footer.** The one or two dim lines at the very bottom: the working directory (with `~` for home), the git branch, the session name; then token counts, cost, context usage, and the current model and thinking level.

**Overlay.** A selector or dialog that takes the editor's place and keyboard focus until it is accepted or dismissed: the model selector, the settings panel, the session picker, the tree, the login dialog, and the rest. Only one overlay is open at a time. Escape dismisses every overlay.

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

## Sessions

**Session.** One conversation, stored as one file under `~/.pi/agent/sessions/` in a directory named after the working directory. A session remembers its messages, the model and thinking level in use, its name, and its tree of branches.

**Session file.** The JSONL file for a session. It is created when the first assistant message arrives, not when the session starts; a session that never got a response leaves no file.

**Ephemeral session.** A session started with `--no-session`. Everything works the same on screen but nothing is written to disk, and there is no resume hint on exit.

**Entry.** One line in a session file: a message, a model change, a thinking-level change, a name change, a label, a compaction, or a branch summary. Each entry points at its parent, so the file is a tree.

**Active position.** The entry the conversation currently continues from: the newest entry on the current branch. `/tree` moves it; everything after it on other branches is still in the file but not in the model's context.

**Branch.** A path from the root entry to a leaf. Submitting a prompt after moving the active position backwards starts a new branch; the old one stays in the file.

**Branch summary.** A summary of the branch being left, generated when `/tree` moves to another branch and the user asks for one. It is attached at the new position so the model knows what was tried.

**Compaction.** Replacing the older part of the conversation with a generated summary so that the model's context fits. Automatic when context exceeds the window minus 16,384 reserved tokens; manual with `/compact`. The newest 20,000 tokens are kept verbatim. Nothing is removed from the session file; only what the model is sent changes.

**Context.** What the model is sent on each call: the system prompt, the messages since the last compaction (with the compaction summary in front), and the tool definitions. Its size as a share of the model's window is shown in the footer.

**Session name.** A display name set with `/name` or `--name`, shown in the footer and in the session picker.

## Input

**Key.** One keystroke as pi decodes it, with modifiers: `enter`, `shift+enter`, `ctrl+c`, `alt+up`. Keybindings map keys to actions and can be changed in `~/.pi/agent/keybindings.json`; these documents describe the defaults.

**Submit.** Pressing Enter in the editor. The text is trimmed and handed to the submit handler, which decides whether it is a slash command, a shell command, a queued message, or a prompt.

**Slash command.** A line beginning with `/` that pi handles itself: `/model`, `/settings`, `/tree`, `/quit`, and the rest. Built-in slash commands run immediately, even while the agent is working. A `/` line pi does not recognise is sent to the model as text.

**Autocomplete popup.** The list that appears under the editor when typing `/` at the start of a line, `@` at a word boundary, or pressing Tab on a path. Up and Down move, Tab or Enter accept, Escape dismisses.

**Prompt history.** The last 100 submitted lines, browsed with Up and Down from the edges of the editor text. Kept in memory for the current run only.

**Double press.** Two presses of the same key within 500 ms: Ctrl+C twice quits; Escape twice on an empty editor opens the tree. The window is measured from the first press.

**Paste.** Text arriving from the terminal's bracketed paste, including dropped file paths. A paste longer than 10 lines or 1,000 characters is collapsed into a `[paste #1 +42 lines]` marker that expands on submit.

## Events that end or interrupt a turn

**Cancel.** The user's explicit abort: Escape. While working it aborts the turn; while a shell command runs it kills the command; while an overlay is open it dismisses the overlay; in bash mode it clears the editor.

**Complete.** An event that ends an interaction cleanly and commits its result: the model stopping without a tool call, a shell command exiting, Enter in an overlay.

**Interrupt.** Something other than the user ending a turn: a provider error, a lost connection, a context overflow, the process being killed. What is kept after each is stated in every document's cancel-and-interrupt table.

**Switch.** Replacing the current session with another (`/new`, `/resume`, `/fork`, `/clone`, `/import`, `/tree` to another branch). A switch aborts any turn in progress, flushes what was aborted into the old session, and drops the queue.

## Models and credentials

**Provider.** A vendor or endpoint pi can talk to: Anthropic, OpenAI, Google, GitHub Copilot, and the rest. Each has its own way of authenticating and its own list of models.

**Model.** One `provider/id` pair. The current model is shown at the right of the footer. Changed with `/model`, Ctrl+L, or Ctrl+P; the choice is recorded in the session and, with Ctrl+S in the selector, as the default.

**Scoped models.** The subset of models that Ctrl+P cycles through, set with `--models` or `/scoped-models`. With no scope, Ctrl+P cycles every available model.

**Credential.** What authenticates a provider: an API key in an environment variable, or an entry in `~/.pi/agent/auth.json` written by `/login` (an API key or an OAuth token). A stored credential takes precedence over an environment variable for the same provider.

**Available model.** A model whose provider has a credential. Only available models can be selected; the footer shows no model when none is.

## Configuration

**Agent directory.** `~/.pi/agent/`, or `PI_CODING_AGENT_DIR` when set: settings, credentials, sessions, keybindings, trust decisions, downloaded tools, and installed packages all live under it.

**Settings.** `~/.pi/agent/settings.json` (global) and `.pi/settings.json` in the project (only when the project is trusted). Project settings override global settings key by key; command-line flags override both. `/settings` edits the global file.

**Working directory.** The directory pi was started in. Tools run there, context files are found by walking up from it, and the session is filed under it.

**Context files.** `AGENTS.md` (or `CLAUDE.md`, or `AGENTS.override.md`) found in the agent directory, in every ancestor of the working directory, and in the working directory itself, all added to the system prompt.

**Trust.** Whether pi may load a project's `.pi/` settings and resources. Asked once per project folder when such resources exist; remembered in `~/.pi/agent/trust.json`. A project with no `.pi/` directory is never asked.
