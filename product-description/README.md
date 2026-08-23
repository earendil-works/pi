# pi product description

A written description of the user experience of pi's interactive mode: what the user sees in the terminal, what they can do, and exactly what happens when they do it.

## Purpose

pi is, from the user's point of view, a large state chart. The user moves through it with keystrokes in a terminal: typing into the editor, pressing Enter, Escape, Ctrl+C, a handful of shortcuts, slash commands, and the occasional paste or dropped file. Most of that behavior is defined implicitly, spread across the interactive mode's key handlers and event handlers, the session and agent runtime, the terminal UI library, and a few hundred tests. There is no single place that says, in plain language, "when the user does X, this is what happens, and this is what happens if they do Y halfway through."

This project is that place. It describes the full experience a user has running `pi` with no arguments in a project directory, in the default configuration: the regular (non-fullscreen) terminal UI, the four default tools, no extensions, no packages, no skills, no prompt templates, no project `.pi/` directory, and a provider already authenticated so that a model is selected.

The documents are for people who need to understand or change the product: designers, engineers, writers, testers, and anyone evaluating whether a behavior is intentional. They are written from the outside in. They describe the experience, not the implementation.

### What this is not

- Not API documentation. That lives in `packages/coding-agent/docs/` (user docs), `docs/sdk.md`, `docs/extensions.md`, and `docs/rpc.md`.
- Not organized by package. `pi-tui`, `pi-agent-core`, `pi-ai`, and `pi-coding-agent` are not described separately. A single behavior is described once, wherever the user encounters it.
- Not a technical design document. Where a technical detail is critical to understanding the experience, it appears in a block quote labeled `Technical note:` and nowhere else.

## Conventions

- Describe the experience, not the code. "The editor empties and a spinner reads Working..." rather than "onSubmit clears the editor and agent_start shows a WorkingStatusIndicator".
- Technical detail goes in block quotes, prefixed with `Technical note:`. Use it only when the mechanism changes what the user would expect.
- Use sentence case for headings.
- Name the vocabulary consistently. The [glossary](glossary.md) is the source of truth for terms like *turn*, *working*, *settled*, *steering message*, *follow-up message*, *overlay*, *session*, *active position*, *compaction*, *thinking level*, and *bash mode*.
- Every document ends with the commit of pi-mono it was verified against and a list of open questions.
- When a behavior is surprising, say so and say why it is that way if the reason is known. Do not smooth it over.

## The work to be done

Each document describes one feature. Features are large things (sending a prompt and watching the response stream in, with tool calls, aborts, and retries) or small things (`/name`), but each is described in full, including its edge cases and its interactions with other features.

### Document template

Every feature document follows the same skeleton so that documents are comparable and nothing is skipped.

1. **Summary.** One paragraph describing the feature abstractly. For example: "A shell command is a line typed into the editor that begins with `!`. The rest of the line is run in the project's shell, its output streams into the transcript in a bordered box, and the command and its output are recorded in the session as a message the model will see on its next turn."
2. **The simple case.** The common path in prose.
3. **The interaction, event by event.** The five phases of a turn: *compose* (what the editor accepts and what Enter does), *resolves at once* (the turn ends without the model: an empty submit, a local command, a refused action), *sent* (the prompt is committed and the model is called; what is shown while waiting), *while working* (streaming text, tool calls, what the user can still do), and *done* (the final rendering, what is persisted, where the editor is left). Documents about an overlay (a selector or dialog that replaces the editor) use the same five slots with overlay names: *open*, *dismissed at once*, *first change*, *while open*, *accepted*. Include a small state diagram (Mermaid `stateDiagram-v2`) of the states the user passes through.
4. **Modifiers.** A table of the variant axis: the model, the thinking level, whether the agent is busy, attachments present, and the session kind (saved or ephemeral), with what each does when set before sending and when changed while working.
5. **Cancel and interrupt.** The same checklist in every document, in this order:
   - Escape (once; twice within 500 ms)
   - Ctrl+C once / twice; Ctrl+D
   - Another message submitted (Enter; Alt+Enter follow-up)
   - A slash command or shortcut that opens an overlay or changes the session
   - Model or thinking level changed
   - Provider error, rate limit, timeout, or network lost
   - Context window exhausted (auto-compaction)
   - Terminal resized; pi suspended (Ctrl+Z) and resumed
   - Process ends: terminal closed (SIGHUP), SIGTERM, killed
   - Session or files changed from outside
   - Credentials lost, or logged out
6. **Interactions with other systems.** In this order: session persistence; branching and history; compaction; context files and the system prompt; settings and keybindings; tools and the working directory; terminal and rendering; credentials and providers.
7. **Edge cases.** Anything a user could notice that is not covered above.
8. **Open questions and verification.** The pi-mono commit the document was verified against, and any behavior that could not be confirmed.

Item 5 matters most. Asking the same interrupt questions of every feature is how gaps and inconsistencies are found.

### Method

For each document:

1. Read the key and event handlers in `packages/coding-agent/src/modes/interactive/interactive-mode.ts` for the feature, the component it renders in `.../interactive/components/`, and the session-level behavior in `packages/coding-agent/src/core/agent-session.ts` and `packages/agent/src/agent-loop.ts`.
2. Read the matching tests in `packages/coding-agent/test/` and `packages/coding-agent/test/suite/`. Files like `test/suite/agent-session-queue.test.ts`, `test/suite/agent-session-retry-events.test.ts`, `test/suite/agent-session-compaction.test.ts`, `test/interactive-mode-status.test.ts`, `test/tree-selector.test.ts`, and `packages/tui/test/editor.test.ts` are close to executable specifications of the edge cases. The `test/suite/regressions/` directory is one file per reported issue and is the sharpest source of "what happens if".
3. Draft the document.
4. Try anything ambiguous in the running product: `./pi-test.sh` from the repo root (in tmux, or with the scripted driver in `verification/driver/`), with `PI_CODING_AGENT_DIR` and `HOME` pointed at scratch directories so the user's own settings, credentials, sessions, and skills are untouched. Tests settle "what happens"; the running product settles how it feels, what is visible while the interaction is in progress, and what the timing is like.
5. Record the commit verified against.

### Verification

Drafting reads the code; verification watches the product. The `verification/` directory holds one checklist per cluster of documents, each item a single observable claim with setup, steps, expected result, a priority, and the condition it needs. A tester runs them in a terminal against `./pi-test.sh` at the recorded commit, records `pass`, `fail`, or `blocked` in the Result column, and files every failure in `bug-triage.md` with the item's ID. A document moves from `drafted` to `verified` in the coverage table only when every P1 and P2 item for it has passed or been filed.

`bug-triage.md` is the other half: every behavior the documents flagged as a likely defect, deduplicated, with reproduction steps, the reason in the code, a severity, and the decision the product team needs to make. Entries confirmed in the running product carry a Status line.

### Order of work

1. **Pilot: [shell commands](conversation/shell-commands.md).** Small and self-contained, with a real interaction (a command starts, streams, can be cancelled, and is recorded). Used to settle the template, tone, and depth.
2. **Foundations: the turn, input, the screen, sessions, models and credentials, configuration.** Everything else refers to them.
3. **The conversation.** Sending a prompt, the editor, tool calls, the message queue: the bulk of the experience and the hardest part, because the states hand off to each other. Written third so the template is already proven.
4. **Everything else.** Once the template and the exemplars exist, the remaining documents can be drafted in parallel, followed by a consistency pass and a verification pass across the whole set.

Progress is tracked in the [coverage table](#coverage) below.

### Scope decisions

- **Surface.** `pi` started with no arguments from a project directory, in the regular TUI mode. The experimental fullscreen mode (`--tui-mode fullscreen`) is out of scope; where a document touches something that differs in fullscreen mode it says so in one line and moves on.
- **Non-interactive modes.** `pi -p`, `--mode json`, `--mode rpc`, and the SDK are out of scope: they have a different unit of interaction (an invocation, a stream of events) and would be a second repo. The package commands (`pi install`, `pi remove`, `pi update`, `pi list`, `pi config`) and `pi auth` are out of scope for the same reason. `pi` with a message or `@file` arguments on the command line is in scope because it lands in interactive mode.
- **Extensions, packages, skills, prompt templates, custom themes, and `models.json`.** Out of scope. The surface is the default installation with nothing customized. Where the default product's behavior changes because a hook exists (an extension can intercept a shell command), the document says "in the default configuration" and does not describe the hook.
- **Providers.** The description assumes one provider is authenticated and a model is selected, because that is the state in which everything else is reachable. The no-credentials path is described once, in [launching pi](startup/launching-pi.md) and [login and logout](models/login-and-logout.md). Provider-specific behavior (OAuth flows for a particular vendor, usage warnings) is described only where the user meets it in the default flow.
- **Windows and Termux.** Described only where the code takes a different path that a user would notice (no Ctrl+Z, Alt+V instead of Ctrl+V, Git Bash). The reference platform is macOS or Linux with a terminal that supports the Kitty keyboard protocol.
- **Concerns described inside each document rather than separately.** Tool output expansion (Ctrl+O), the editor border colour, and the footer are part of every feature that touches them; a separate document for each would drift.
- **Concerns described once in a cross-cutting document rather than in every feature.** What is available while the agent is busy, error display and retries, terminal differences, the process lifecycle, and the clipboard each get one document that the feature documents link to.
- **Interaction shape.** The unit of interaction is a turn and its phases are compose, resolves at once, sent, while working, done. Overlays use open, dismissed at once, first change, while open, accepted. The interrupt list and the order of cross-cutting concerns are fixed as written in the document template above.
- **Numbered rules.** These are prose documents, not numbered specifications. Stable heading anchors are enough for cross-references.

## Structure

```
README.md                        this file
goal.md                          the standing instructions for whoever drafts
AGENTS.md, CLAUDE.md             entry points for agents: read README.md, then goal.md
glossary.md                      shared vocabulary
bug-triage.md                    suspected defects collected from every document, with repro steps and decisions needed

verification/
  README.md                      how to run a hand-verification pass and record results
  conversation.md                checklists for foundations/ and conversation/
  sessions.md                    checklists for sessions/ and startup/
  settings.md                    checklists for models/, settings/, and cross-cutting/
  driver/                        a scripted pseudo-terminal driver (drive.py, render.mjs, an example scenario)
                                 for the items that can be checked without a person at the keyboard

foundations/
  the-turn.md                    what a turn is: prompt, working, done; what sent, working, and settled mean;
                                 what is recorded when; abort, retry, and the queue rules every feature obeys
  input.md                       keys and what they mean: the default keybindings, Escape, Ctrl+C, Ctrl+D, the
                                 500 ms double-press windows, the Kitty keyboard protocol, what cancels and what completes
  the-screen.md                  the parts of the screen: header, transcript, pending area, status line, editor,
                                 footer; overlays that replace the editor; terminal width and scrollback
  sessions.md                    the session file, how it is chosen for a directory, the tree and the active
                                 position, what is written when, ephemeral sessions
  models-and-credentials.md      providers, how the startup model is chosen, thinking levels, where credentials
                                 live, what works with no credentials
  configuration.md               where pi keeps its files, settings precedence, defaults, keybindings.json, trust.json

conversation/
  the-editor.md                  typing: multi-line input, cursor movement, deleting, the kill ring, undo, prompt
                                 history, paste, the external editor
  autocomplete.md                the popup for @ files, / commands, and Tab path completion
  sending-a-prompt.md            Enter to done: validation, the working indicator, streaming text and thinking,
                                 abort, retry, errors, what is persisted
  tool-calls.md                  read, write, edit, bash, grep, find, ls as they appear in the transcript; collapsed
                                 and expanded output; images; abort mid-tool
  the-message-queue.md           steering and follow-up messages, dequeue, the queue during compaction
  shell-commands.md              ! and !! (the pilot)
  attachments.md                 @file arguments, image paste, dropped files, images in the transcript
  thinking.md                    thinking levels, Shift+Tab, /thinking, Ctrl+T, the border colour
  the-transcript.md              how every kind of message is rendered; status lines, errors, notices; Ctrl+O;
                                 copying a response

sessions/
  new-session.md                 /new
  resuming.md                    /resume, -c, -r, --session, --fork; the session picker with search, rename, delete
  the-tree.md                    /tree, branch summaries, labels, filters, the double-Escape shortcut
  fork-and-clone.md              /fork and /clone
  naming-and-info.md             /name, --name, /session
  compaction.md                  auto-compaction, /compact, overflow recovery, what the summary looks like
  export-import-share.md         /export, /import, /share
  quitting.md                    /quit, Ctrl+D, Ctrl+C twice, the resume hint

models/
  the-model-selector.md          /model and Ctrl+L
  cycling-models.md              Ctrl+P, Shift+Ctrl+P, /scoped-models, --models
  login-and-logout.md            /login and /logout, the OAuth and API-key dialogs

settings/
  the-settings-panel.md          /settings and its submenus, what each row changes and when it takes effect
  themes.md                      the theme setting, automatic light and dark
  reload-and-hotkeys.md          /reload, /hotkeys, /changelog
  project-trust.md               the startup trust prompt and /trust

startup/
  launching-pi.md                the command line, what is printed at startup, the initial prompt and @files, the
                                 update notice, starting with no credentials

cross-cutting/
  busy-state.md                  what is and is not available while the agent is working, compacting, or retrying
  errors-and-retries.md          how errors are shown; retry; rate limits; network loss
  the-terminal.md                terminal differences: the Kitty protocol, Shift+Enter, images, resize, tmux, Windows
  process-lifecycle.md           Ctrl+Z, signals, crashes, what is left on disk
  clipboard.md                   copy and paste in every form
```

## Coverage

Status is one of `not started`, `drafted`, or `verified`.

| Document | Status |
| --- | --- |
| glossary.md | drafted |
| bug-triage.md | drafted |
| verification/ (3 checklists) | not started |
| foundations/the-turn.md | drafted |
| foundations/input.md | drafted |
| foundations/the-screen.md | drafted |
| foundations/sessions.md | drafted |
| foundations/models-and-credentials.md | drafted |
| foundations/configuration.md | drafted |
| conversation/the-editor.md | drafted |
| conversation/autocomplete.md | drafted |
| conversation/sending-a-prompt.md | drafted |
| conversation/tool-calls.md | drafted |
| conversation/the-message-queue.md | drafted |
| conversation/shell-commands.md | drafted |
| conversation/attachments.md | drafted |
| conversation/thinking.md | drafted |
| conversation/the-transcript.md | drafted |
| sessions/new-session.md | drafted |
| sessions/resuming.md | drafted |
| sessions/the-tree.md | drafted |
| sessions/fork-and-clone.md | drafted |
| sessions/naming-and-info.md | drafted |
| sessions/compaction.md | drafted |
| sessions/export-import-share.md | drafted |
| sessions/quitting.md | drafted |
| models/the-model-selector.md | drafted |
| models/cycling-models.md | drafted |
| models/login-and-logout.md | drafted |
| settings/the-settings-panel.md | drafted |
| settings/themes.md | drafted |
| settings/reload-and-hotkeys.md | drafted |
| settings/project-trust.md | drafted |
| startup/launching-pi.md | drafted |
| cross-cutting/busy-state.md | drafted |
| cross-cutting/errors-and-retries.md | drafted |
| cross-cutting/the-terminal.md | drafted |
| cross-cutting/process-lifecycle.md | drafted |
| cross-cutting/clipboard.md | drafted |

## Reference

The source of truth is the pi-mono repository this directory lives in, at the commit named in each document's footer. Paths are relative to the repository root. The relevant locations are:

- `packages/coding-agent/src/cli.ts`, `src/main.ts`: the entry point; argument parsing, startup order, session selection, the trust prompt, and the hand-off to interactive mode.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: the surface this project describes. Key handlers, the submit handler and slash-command dispatch, agent event handling, the overlays, startup and shutdown.
- `packages/coding-agent/src/modes/interactive/components/`: what is drawn: the editor wrapper, messages, tool calls, bash boxes, the footer, the status indicator, and every selector and dialog.
- `packages/coding-agent/src/modes/interactive/theme/`: the built-in dark and light themes and the colour roles (border colours per thinking level, bash mode).
- `packages/coding-agent/src/core/agent-session.ts`, `agent-session-runtime.ts`: the turn: prompt validation, the queue, abort, retry, compaction, branching, shell commands, session replacement.
- `packages/agent/src/agent.ts`, `agent-loop.ts`: the agent loop: streaming, tool execution, steering and follow-up delivery points.
- `packages/coding-agent/src/core/session-manager.ts`: the session file, its tree, when it is written, discovery per directory.
- `packages/coding-agent/src/core/settings-manager.ts`, `keybindings.ts`, `defaults.ts`, `config.ts`: defaults and thresholds; settings precedence; the default keybindings; where files live.
- `packages/coding-agent/src/core/tools/`: the built-in tools, their limits, and how they render.
- `packages/coding-agent/src/core/compaction/`: auto-compaction and branch summaries.
- `packages/coding-agent/src/core/model-resolver.ts`, `model-runtime.ts`, `auth-storage.ts`, `packages/ai/src/auth/`: model resolution, credentials, OAuth refresh.
- `packages/tui/src/`: the terminal UI library: the editor (`components/editor.ts`), key decoding (`keys.ts`, `terminal.ts`), autocomplete, the kill ring and undo stack.
- `packages/coding-agent/test/`, `test/suite/`, `test/suite/regressions/`, `packages/tui/test/`: behavioral tests.
- `packages/coding-agent/docs/`: the user documentation, useful for the product's own wording.
