# Verification: foundations and conversation

How to run this file: start from a fresh home (`rm -rf /tmp/pi-desc-home`) and an empty project directory with `git init` run in it, at 100×40 or larger. Items marked `keyboard` need no credential; run them with `--no-env` and `PI_OFFLINE=1`. Items marked `model` need one provider key and a cheap model at thinking level `off` or `low`; they observe structure and state, not wording. Clear between sections by quitting pi (`/quit`) and, where the section says "fresh home", deleting the home directory. Results marked "driver" were observed with `driver/drive.py` on 2026-08-23 at commit `a69bef789`; everything else is `—`.

## foundations/the-turn.md

| ID | P | Device | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TURN-01 | P1 | keyboard | With no credential, the first prompt fails before anything is sent and nothing is drawn or recorded ([Resolves at once](../foundations/the-turn.md#resolves-at-once)). | Fresh home, `--no-env`. | 1. Type `hello` and press Enter.<br>2. `/session`. | `Error: No API key found for the selected model.` then the login help; no user message in the transcript; `/session` shows `User: 0`. | pass (driver; bare `!` took the same path) |
| TURN-02 | P1 | model | The user message is drawn and in the session before the model answers ([Sent](../foundations/the-turn.md#sent)). | One credential. | 1. Send `Reply with one word`.<br>2. Press Escape within 300 ms. | The prompt is in the transcript; an aborted assistant block with `Operation aborted`; `/session` counts `User: 1`, `Assistant: 1`. | — |
| TURN-03 | P1 | model | The status line reads `Working... (escape to interrupt)` during a turn and clears when it settles ([While working](../foundations/the-turn.md#while-working)). | One credential. | 1. Send a short prompt.<br>2. Watch the line above the editor. | Spinner with that text while working; empty afterwards. | — |
| TURN-04 | P1 | model | Escape aborts: partial text stays, `Operation aborted` is appended, the turn settles ([Cancel and interrupt](../foundations/the-turn.md#cancel-and-interrupt)). | One credential. | 1. Send `Count slowly from 1 to 200, one per line`.<br>2. Press Escape after a few lines. | Text so far remains; `Operation aborted` in the error colour below it; status line empty; Enter sends again. | — |
| TURN-05 | P1 | model | Escape returns queued messages to the editor ([Cancel and interrupt](../foundations/the-turn.md#cancel-and-interrupt)). | One credential. | 1. Send a long prompt.<br>2. Type `second` and press Enter (queued).<br>3. Press Escape. | The editor contains `second`; the pending area is empty. | — |
| TURN-06 | P2 | model | A steering message is delivered after the current tool calls, before the next model call ([While working](../foundations/the-turn.md#while-working)). | One credential, a repo with files. | 1. Send `Read README.md then summarise it`.<br>2. While the read box is pending, type `Also count its lines` and press Enter. | `Steering: Also count its lines` in the pending area; after the tool box completes, the steering text appears as a user message and the next assistant message addresses it. | — |
| TURN-07 | P2 | model | A follow-up is delivered only when the model would stop ([While working](../foundations/the-turn.md#while-working)). | One credential. | 1. Send a prompt that triggers a tool call.<br>2. Type `then say done` and press Alt+Enter. | `Follow-up: …` waits through the tool calls and the final answer, then becomes a user message and another answer follows, all under one `Working...`. | — |
| TURN-08 | P1 | model, network | A transient error shows `Retrying (1/3) in 2s...` counting down; Escape cancels with `Retry failed after 1 attempts: Retry cancelled` ([Cancel and interrupt](../foundations/the-turn.md#cancel-and-interrupt)). | One credential. | 1. Send a prompt.<br>2. Cut the network before the first token.<br>3. Watch the status line; press Escape during the countdown. | Countdown text as stated; after Escape, the error line; the turn settles. | — |
| TURN-09 | P3 | model, network | Retry waits are 2, 4, 8 s and the third failure prints `Retry failed after 3 attempts:` ([Cancel and interrupt](../foundations/the-turn.md#cancel-and-interrupt)). | As TURN-08, network kept off. | 1. Let all three attempts fail. | Countdowns start at 2, 4, 8; final error line; settled. | — |
| TURN-10 | P2 | model | Changing the model mid-turn applies from the next model call ([Modifiers](../foundations/the-turn.md#modifiers)). | Two credentials. | 1. Send a prompt that calls a tool.<br>2. Press Ctrl+P while the tool runs. | The footer changes at once; the answer after the tool comes from the new model (check `/session`'s per-model cost lines). | — |
| TURN-11 | P2 | model | A `/` line pi does not know is sent to the model as text ([Edge cases](../foundations/the-turn.md#edge-cases)). | One credential. | 1. Send `/foo what is this`. | A user message `/foo what is this` and a model answer; no error. | — |
| TURN-12 | P1 | model | `/new` while working aborts the turn and drops the queue without returning it ([Cancel and interrupt](../foundations/the-turn.md#cancel-and-interrupt)). (suspected bug) | One credential. | 1. Send a long prompt; queue `second` with Enter.<br>2. `/new`. | Record what happens to `second`: expected gone, not in the editor. | — |

Not checkable by hand:

- Whether the aborted assistant message reaches the file on SIGTERM/SIGHUP (timing-dependent; see [Open questions](../foundations/the-turn.md#open-questions-and-verification)).

## foundations/input.md

| ID | P | Device | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| INPUT-01 | P1 | keyboard | One Ctrl+C clears the editor; two within 500 ms quit ([Ctrl+C and Ctrl+D](../foundations/input.md#ctrlc-and-ctrld)). | Any. | 1. Type `abc`, press Ctrl+C once, wait 1 s.<br>2. Press Ctrl+C twice quickly. | After step 1 the editor is empty and pi is running; after step 2 pi has exited. | pass (driver: clear observed; double press exited 0) |
| INPUT-02 | P1 | keyboard | Ctrl+D quits only with an empty editor; with text it deletes forward ([Ctrl+C and Ctrl+D](../foundations/input.md#ctrlc-and-ctrld)). | Any. | 1. Type `abc`, press Home, press Ctrl+D.<br>2. Clear the editor, press Ctrl+D. | Step 1: `bc`; step 2: pi exits. | — |
| INPUT-03 | P1 | keyboard | Escape twice within 500 ms on an empty editor opens the tree ([Escape](../foundations/input.md#escape)). | Any, editor empty. | 1. Press Escape, then Escape again within 500 ms. | The `Session Tree` overlay replaces the editor. | pass (driver, 200 ms apart) |
| INPUT-04 | P2 | keyboard | Escape twice more than 500 ms apart does nothing ([Escape](../foundations/input.md#escape)). | Editor empty. | 1. Press Escape, wait 1 s, press Escape. | No overlay. | — |
| INPUT-05 | P1 | keyboard | Escape with text in the editor does nothing unless the text starts with `!` ([Escape](../foundations/input.md#escape)). | Any. | 1. Type `abc`, press Escape.<br>2. Clear; type `!ls`, press Escape. | Step 1: `abc` stays; step 2: the editor is empty. | — |
| INPUT-06 | P1 | keyboard | Shift+Enter inserts a newline; Enter submits ([Default keybindings](../foundations/input.md#default-keybindings)). | Kitty-protocol terminal. | 1. Type `a`, Shift+Enter, `b`. | Two lines in the editor. | pass (driver, CSI u sequence) |
| INPUT-07 | P2 | keyboard | Ctrl+W twice then Ctrl+Y restores both words: consecutive kills join ([Default keybindings](../foundations/input.md#default-keybindings)). | Any. | 1. Type `abc def ghi`; Ctrl+W, Ctrl+W; Ctrl+Y. | `abc ` after the kills; `abc def ghi` after the yank. | pass (driver) |
| INPUT-08 | P2 | keyboard | Ctrl+- undoes; there is no redo ([Default keybindings](../foundations/input.md#default-keybindings)). | Any. | 1. Type `one two`; Ctrl+-; Ctrl+-. | `one ` then `` (or `one`), no key brings `two` back. | — |
| INPUT-09 | P2 | keyboard | Ctrl+C inside an overlay cancels the overlay and does not count toward quitting ([Edge cases](../foundations/input.md#edge-cases)). | Any. | 1. `/settings`; press Ctrl+C; press Ctrl+C again within 500 ms. | The panel closes on the first; pi keeps running after the second (the editor clears). | — |
| INPUT-10 | P3 | keyboard, macOS | Hints print `option` where the documents write `Alt` ([Summary](../foundations/input.md#summary)). | macOS. | 1. Press Ctrl+O to expand the header. | `option+enter to queue follow-up`. | pass (driver) |
| INPUT-11 | P2 | legacy terminal | Without the Kitty protocol, Shift+Enter arrives as Enter ([A keystroke, event by event](../foundations/input.md#a-keystroke-event-by-event)). | xfce4-terminal or similar. | 1. Type `a`, Shift+Enter. | The line is submitted instead of a newline being added. | — |

## foundations/the-screen.md

| ID | P | Device | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SCREEN-01 | P1 | keyboard | The collapsed header is the logo, one hint strip, and two dim lines ([The parts of the screen](../foundations/the-screen.md#the-parts-of-the-screen)). | Fresh home. | 1. Start pi. | `pi v<version>`; `escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more`; `Press ctrl+o to show full startup help and loaded resources.`; `Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.` | pass (driver) |
| SCREEN-02 | P2 | keyboard | Ctrl+O expands the header and prints `Tool output: expanded` ([The parts of the screen](../foundations/the-screen.md#the-parts-of-the-screen)). | Fresh home. | 1. Press Ctrl+O. | About twenty hint lines; the status line; Ctrl+O again collapses and the status becomes `Tool output: collapsed` in place. | pass (driver) |
| SCREEN-03 | P1 | keyboard | Footer line 1 is the cwd with `~`, the git branch, the session name ([The parts of the screen](../foundations/the-screen.md#the-parts-of-the-screen)). | A git repo under the home directory. | 1. Start pi; `/name Demo`. | `~/path (main) • Demo`. | partial (driver: cwd shown, truncated with `...`; branch and name not observed at that width) |
| SCREEN-04 | P1 | keyboard | With no credential the footer's right side is `unknown` and the context readout `0.0%/0 (auto)` ([The parts of the screen](../foundations/the-screen.md#the-parts-of-the-screen)). | Fresh home, `--no-env`. | 1. Start pi. | As stated. | pass (driver) |
| SCREEN-05 | P2 | model | After a response the footer shows `↑`, `↓`, `$`, and `pct%/window (auto)` and the model with ` • level` ([The parts of the screen](../foundations/the-screen.md#the-parts-of-the-screen)). | One credential, reasoning model. | 1. Send a prompt. | Token counts and cost appear; the right side reads `<model> • medium` (or the chosen level). | — |
| SCREEN-06 | P3 | model | The context percentage turns warning above 70% and error above 90% ([The parts of the screen](../foundations/the-screen.md#the-parts-of-the-screen)). | A model with a small window. | 1. Fill the context past 70%, then 90%. | Colour changes at the thresholds. | — |
| SCREEN-07 | P2 | keyboard | Consecutive status messages replace one another ([Edge cases](../foundations/the-screen.md#edge-cases)). | Any. | 1. Press Ctrl+O twice. | One status line, reading `Tool output: collapsed`. | pass (driver) |
| SCREEN-08 | P2 | keyboard | An overlay replaces the editor and the editor text returns when it closes ([The parts of the screen](../foundations/the-screen.md#the-parts-of-the-screen)). | Any. | 1. Type `draft`; press Ctrl+L; press Escape. | The selector shows in the editor's slot; afterwards `draft` is back. | — |
| SCREEN-09 | P3 | keyboard | The editor is three lines tall and grows with content ([The parts of the screen](../foundations/the-screen.md#the-parts-of-the-screen)). | Any. | 1. Observe the empty editor; add five lines with Shift+Enter. | Border, one line, border; then seven lines. | pass (driver: 3 lines empty, 4 with two lines) |

## foundations/sessions.md

| ID | P | Device | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SESS-01 | P1 | keyboard | No session file exists until the first assistant message ([The session model](../foundations/sessions.md#the-session-model)). | Fresh home, `--no-env`. | 1. Run `!echo hi`; `/name x`; quit.<br>2. `ls ~/.pi-desc-home/sessions/*/`. | The directory exists and is empty; no resume hint was printed. | pass (driver) |
| SESS-02 | P1 | model | The file appears with the first response and is named `<timestamp>_<uuid>.jsonl` under a `--path--` directory ([The session model](../foundations/sessions.md#the-session-model)). | One credential. | 1. Send a prompt; wait for the answer.<br>2. List the sessions directory. | One file named as stated; the directory name is the cwd with `/` replaced by `-`, wrapped in `--`. | — |
| SESS-03 | P1 | model | Each message is appended as it completes ([The session model](../foundations/sessions.md#the-session-model)). | One credential. | 1. Send a prompt that calls two tools.<br>2. `tail -f` the file in another shell. | Lines appear per message, not at the end of the turn. | — |
| SESS-04 | P1 | keyboard | `/fork` and `/clone` refuse before the first response with `This session has not been saved yet…` ([The session model](../foundations/sessions.md#the-session-model)). | Fresh home, `--no-env`. | 1. `/clone`. | The refusal text. | — |
| SESS-05 | P2 | model | Resuming restores the model, thinking level, name, and transcript ([The session model](../foundations/sessions.md#the-session-model)). | A saved session with a changed level and a name. | 1. Quit; `pi -c`. | Footer shows the same model, level, and name; the transcript is redrawn. | — |
| SESS-06 | P2 | model, second process | Two pi processes on one session interleave entries; `/tree` shows extra roots ([The session model](../foundations/sessions.md#the-session-model)). | A saved session. | 1. Open it in two terminals with `--session <id>`.<br>2. Send a prompt in each; `/tree` in one after restart. | Both sets of entries are in the file; the tree shows two roots. | — |
| SESS-07 | P2 | keyboard | A non-session file given to `--session` is refused with `Session file is not a valid pi session` and pi exits ([Edge cases](../foundations/sessions.md#edge-cases)). | A text file `x.jsonl` containing `hello`. | 1. `pi --session ./x.jsonl`. | The red error; exit code 1. | — |
| SESS-08 | P2 | keyboard | `--no-session` prints no resume hint and writes nothing ([The session model](../foundations/sessions.md#the-session-model)). | `--no-session`, one credential optional. | 1. Send a prompt (or `!echo`); quit. | No hint; no new file. | — |

## foundations/models-and-credentials.md

| ID | P | Device | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MODEL-01 | P1 | keyboard | With no credential: the startup warning, `unknown` in the footer, and the first prompt's error ([Credentials](../foundations/models-and-credentials.md#credentials)). | Fresh home, `--no-env`. | 1. Start pi; send `hi`. | `Warning: No models available. Use /login to log into a provider via OAuth or API key. See:` + paths; footer `unknown`; `Error: No API key found for the selected model.` | pass (driver) |
| MODEL-02 | P1 | model | With one key in the environment the footer shows that provider's default model at `medium` ([Models, providers, and availability](../foundations/models-and-credentials.md#models-providers-and-availability)). | Fresh home, `ANTHROPIC_API_KEY` set. | 1. Start pi. | `claude-opus-4-8 • medium` (or the current default for that provider). | — |
| MODEL-03 | P2 | model | Ctrl+S in the model selector saves a default that wins at the next start ([Models, providers, and availability](../foundations/models-and-credentials.md#models-providers-and-availability)). | Two models available. | 1. Ctrl+L, choose another model with Ctrl+S; quit; start pi. | `Default model: …` status; the new model at the next start; `settings.json` has `defaultProvider`/`defaultModel`. | — |
| MODEL-04 | P2 | model | A stored credential beats an environment variable for the same provider ([Credentials](../foundations/models-and-credentials.md#credentials)). | A valid env key and a `/login` with a bad key for the same provider. | 1. Send a prompt. | The request fails with the provider's authentication error (the bad stored key was used). | — |
| MODEL-05 | P2 | model | `/logout` removes only the stored credential; an env key keeps the provider available ([Credentials](../foundations/models-and-credentials.md#credentials)). | Env key plus a stored one. | 1. `/logout` the provider; send a prompt. | `Removed stored API key for <provider>. Environment variables and models.json config are unchanged.`; the prompt succeeds. | — |
| MODEL-06 | P3 | keyboard | `pi --help` says `--provider` defaults to `google` (suspected documentation bug) ([Open questions](../foundations/models-and-credentials.md#open-questions-and-verification)). | Any. | 1. `pi --help`. | Record the `--provider` line. | — |
| MODEL-07 | P2 | keyboard | Shift+Tab on a model without reasoning says `Current model does not support thinking` ([Models, providers, and availability](../foundations/models-and-credentials.md#models-providers-and-availability)). | `--no-env` (placeholder model). | 1. Press Shift+Tab. | The status line. | pass (driver) |

## foundations/configuration.md

| ID | P | Device | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CONF-01 | P1 | keyboard | A fresh run creates `settings.json` with only `lastChangelogVersion`, plus empty `auth.json` and `models-store.json` ([The agent directory](../foundations/configuration.md#the-agent-directory)). | Fresh home. | 1. Start pi; quit.<br>2. `cat` the three files. | `{"lastChangelogVersion": "<version>"}`; `{}`; `{}`. | pass (driver) |
| CONF-02 | P1 | keyboard | `/settings` writes each change to the global file at once ([Changing configuration at runtime](../foundations/configuration.md#changing-configuration-at-runtime)). | Fresh home. | 1. `/settings`; change `Output padding` to 0; Escape.<br>2. `cat settings.json`. | `"outputPad": 0` is in the file. | — |
| CONF-03 | P2 | keyboard | Project settings override global for a trusted project ([Precedence](../foundations/configuration.md#precedence)). | Global `theme: dark`; project `.pi/settings.json` with `theme: light`; answer Trust. | 1. Start pi. | The light theme is used. | — |
| CONF-04 | P2 | keyboard | An unparseable `settings.json` is a startup warning, not a crash ([Precedence](../foundations/configuration.md#precedence)). | `settings.json` containing `{`. | 1. Start pi. | A warning naming the file; pi runs with defaults. | — |
| CONF-05 | P2 | keyboard | `PI_CODING_AGENT_DIR` relocates everything ([The agent directory](../foundations/configuration.md#the-agent-directory)). | Empty target directory. | 1. Start with the variable set; quit. | The files from CONF-01 appear in the target directory, nothing in `~/.pi/agent`. | pass (driver) |
| CONF-06 | P3 | keyboard | `keybindings.json` changes apply after `/reload` ([Keybindings](../foundations/configuration.md#keybindings)). | `{"tui.input.newLine": "ctrl+n"}` in the file. | 1. `/reload`; press Ctrl+N. | A newline is inserted. | — |

## conversation/the-editor.md

| ID | P | Device | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| EDIT-01 | P1 | keyboard | A paste of more than 10 lines collapses to `[paste #1 +N lines]` and Backspace removes the marker whole ([Compose](../conversation/the-editor.md#compose)). | Any. | 1. Paste 12 lines.<br>2. Press Backspace. | `[paste #1 +12 lines]`; then an empty editor. | pass (driver) |
| EDIT-02 | P1 | model | The paste marker expands on submit ([Sent](../conversation/the-editor.md#sent)). | One credential. | 1. Paste 12 lines; press Enter. | The user message in the transcript shows all 12 lines. | — |
| EDIT-03 | P1 | keyboard | Up at the top recalls the previous submission; Down past the newest restores the draft ([Compose](../conversation/the-editor.md#compose)). | `--no-env`. | 1. Run `!echo one`; `!echo two`.<br>2. Type `draft`, Home, Up, Up, Down, Down. | `!echo two`, `!echo one`, `!echo two`, `draft`. | — |
| EDIT-04 | P2 | keyboard | Built-in slash commands are not added to history ([Compose](../conversation/the-editor.md#compose)). | `--no-env`. | 1. `/hotkeys`; press Up. | The editor stays empty (or shows the last non-command submission). | — |
| EDIT-05 | P2 | keyboard | Ctrl+G opens the external editor and replaces the text on exit 0 ([While working](../conversation/the-editor.md#while-working)). | `EDITOR=nano`. | 1. Type `abc`; Ctrl+G; edit to `abcdef`; save and exit. | pi redraws with `abcdef` in the editor. | — |
| EDIT-06 | P2 | keyboard | A non-zero editor exit leaves the text unchanged ([Resolves at once](../conversation/the-editor.md#resolves-at-once)). | `EDITOR=vim`. | 1. Type `abc`; Ctrl+G; `:cq`. | `abc` unchanged. | — |
| EDIT-07 | P2 | keyboard | `\` then Enter inserts a newline ([Compose](../conversation/the-editor.md#compose)). | Any. | 1. Type `a\`, press Enter. | Two lines, the backslash gone. | — |
| EDIT-08 | P3 | keyboard | The editor grows to 30% of the height and then scrolls ([Compose](../conversation/the-editor.md#compose)). | 40-row terminal. | 1. Add 15 lines with Shift+Enter. | The box stops growing at about 12 text lines and scrolls. | — |
| EDIT-09 | P2 | keyboard | Ctrl+] then a character jumps to it ([Compose](../conversation/the-editor.md#compose)). | Any. | 1. Type `find the x here`; Home; Ctrl+]; `x`. | The cursor is on `x`. | — |

## conversation/autocomplete.md

| ID | P | Device | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AUTO-01 | P1 | keyboard | `/` at the start opens the command list, five at a time, `settings` first, with a `(1/N)` counter ([Open](../conversation/autocomplete.md#open)). | Any. | 1. Type `/`. | As stated. | pass (driver: `(1/24)`) |
| AUTO-02 | P1 | keyboard | Typing filters; Enter on a slash command submits it ([Accepted](../conversation/autocomplete.md#accepted)). | Any. | 1. Type `/hot`; press Enter. | Only `hotkeys` listed; the hotkeys table is printed. | pass (driver) |
| AUTO-03 | P1 | keyboard | `@` at a word boundary lists matching files ([Open](../conversation/autocomplete.md#open)). | A repo with `README.md`; `fd` available. | 1. Type `@re`. | `README.md` listed. | pass (driver) |
| AUTO-04 | P2 | keyboard | Tab inserts a file path with a trailing space; a directory with `/` and no space ([Accepted](../conversation/autocomplete.md#accepted)). | A repo with `src/`. | 1. `@sr`, Tab; then `@RE`, Tab. | `@src/` (no space); `@README.md ` (space). | — |
| AUTO-05 | P2 | keyboard | Escape closes the popup without reaching the abort or double-Escape logic ([Dismissed at once](../conversation/autocomplete.md#dismissed-at-once)). | Any. | 1. Type `/`; Escape; Escape within 500 ms. | The list closes; no tree overlay opens (the editor has `/`). | — |
| AUTO-06 | P2 | keyboard | `/` not at the start does not open the list ([Edge cases](../conversation/autocomplete.md#edge-cases)). | Any. | 1. Type `see http://x/`. | No popup. | — |
| AUTO-07 | P3 | keyboard | Page Up/Down do nothing in the popup (suspected bug) ([Open questions](../conversation/autocomplete.md#open-questions-and-verification)). | Any. | 1. Type `/`; press Page Down. | Record whether the highlight moves. | — |

## conversation/sending-a-prompt.md

| ID | P | Device | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SEND-01 | P1 | model | The simple case: prompt drawn, spinner, streamed markdown, footer update ([The simple case](../conversation/sending-a-prompt.md#the-simple-case)). | One credential. | 1. Send `Give me a three-item markdown list`. | User box; `Working... (escape to interrupt)`; a list renders as it streams; the spinner clears; the footer shows tokens and cost. | — |
| SEND-02 | P1 | model | A tool call box appears before its arguments are complete, in the pending tint, then turns success ([While working](../conversation/sending-a-prompt.md#while-working)). | One credential, a repo. | 1. Send `Read README.md and quote its first line`. | `read README.md` appears tinted before the read finishes; tint changes; the answer follows. | — |
| SEND-03 | P2 | model | Ctrl+T during streaming collapses thinking to `Thinking...` at once ([While working](../conversation/sending-a-prompt.md#while-working)). | A reasoning model at `high`. | 1. Send a hard question; press Ctrl+T while thinking streams. | The italic block becomes one `Thinking...` line immediately. | — |
| SEND-04 | P2 | model | Nothing but the spinner is shown before the first token ([Sent](../conversation/sending-a-prompt.md#sent)). | One credential. | 1. Send a prompt; watch the first second. | No elapsed counter, no "connecting" text. | — |
| SEND-05 | P1 | model | Escape during a tool call marks the box `Operation aborted` in the error tint ([Cancel and interrupt](../conversation/sending-a-prompt.md#cancel-and-interrupt)). | One credential. | 1. Send `Run sleep 20 with bash`; press Escape while it runs. | The `$ sleep 20` box shows the error tint and `Operation aborted`. | — |
| SEND-06 | P2 | model | A prompt on the command line is sent before the user types ([Edge cases](../conversation/sending-a-prompt.md#edge-cases)). | One credential. | 1. `pi "Say hello"`. | The turn starts right after the header. | — |
| SEND-07 | P2 | model | Text typed during startup is held and replayed with `Startup is still in progress` ([Edge cases](../conversation/sending-a-prompt.md#edge-cases)). | Slow startup (first run with a download). | 1. Type and press Enter during the download. | The status; the text is back in the editor afterwards. | — |

## conversation/tool-calls.md

| ID | P | Device | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TOOL-01 | P1 | model | `bash` shows `$ cmd`, the last 5 lines, `... (N earlier lines, Ctrl+O to expand)`, and `Took Ns` ([Done](../conversation/tool-calls.md#done)). | One credential. | 1. Send `Run seq 1 100 with bash`. | As stated; Ctrl+O shows all 100 lines. | — |
| TOOL-02 | P1 | model | `read` shows only its header collapsed; Ctrl+O shows the file ([Done](../conversation/tool-calls.md#done)). | One credential, a repo. | 1. Send `Read README.md`. | `read README.md` one line; expanded shows the content. | — |
| TOOL-03 | P1 | model | `edit` shows a diff with removed and added lines ([While working](../conversation/tool-calls.md#while-working)). | A repo with a small file. | 1. Send `Change the first line of README.md to "# Demo"`. | `edit README.md` with a `-`/`+` diff; the file is changed. | — |
| TOOL-04 | P2 | model | A non-zero exit shows `Command exited with code N` and the model is told ([Done](../conversation/tool-calls.md#done)). | One credential. | 1. Send `Run the command false with bash and tell me the exit code`. | The box in the error tint with the message; the answer names code 1. | — |
| TOOL-05 | P2 | model | Output over 50 KB is truncated with a temp-file path ([Done](../conversation/tool-calls.md#done)). | One credential. | 1. Send `Run seq 1 100000 with bash`. | The box ends with a `Full output: /tmp/pi-bash-….log` note; the file exists. | — |
| TOOL-06 | P2 | model | `bash` calls do not share state ([Interactions with other systems](../conversation/tool-calls.md#interactions-with-other-systems)). | One credential. | 1. Send `Run "cd /tmp" with bash, then run "pwd" with bash`. | The second command prints the project directory. | — |
| TOOL-07 | P2 | model | `grep`, `find`, `ls` are off by default ([Summary](../conversation/tool-calls.md#summary)). | One credential. | 1. Send `List the tools you have`. | The answer names read, bash, edit, write only. | — |
| TOOL-08 | P3 | model | `write` reports `Successfully wrote N bytes` with N the character count (suspected bug) ([Edge cases](../conversation/tool-calls.md#edge-cases)). | One credential. | 1. Send `Write the single character é to x.txt with the write tool and tell me what the tool reported`. | Record N (expected 1 though the file is 2 bytes). | — |

## conversation/the-message-queue.md

| ID | P | Device | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| QUEUE-01 | P1 | model | Enter while working shows `Steering: …` and the `↳ Alt+Up` hint ([Sent](../conversation/the-message-queue.md#sent)). | One credential. | 1. Send a long prompt; type `x` and press Enter. | The pending area as stated. | — |
| QUEUE-02 | P1 | model | Alt+Up returns the queue to the editor with `Restored N queued messages to editor` ([While working](../conversation/the-message-queue.md#while-working)). | As QUEUE-01. | 1. Press Alt+Up. | The editor holds `x`; the status line. | — |
| QUEUE-03 | P2 | model | Alt+Enter when idle acts as Enter ([Resolves at once](../conversation/the-message-queue.md#resolves-at-once)). | One credential, idle. | 1. Type `hi`, press Alt+Enter. | A normal turn starts. | — |
| QUEUE-04 | P2 | model | During compaction, Enter queues with `Queued message for after compaction` ([Sent](../conversation/the-message-queue.md#sent)). | A session near the threshold. | 1. `/compact`; press Enter on some text during it. | The status; the message is sent after compaction ends. | — |
| QUEUE-05 | P1 | model | A session switch drops the queue silently (suspected bug) ([Open questions](../conversation/the-message-queue.md#open-questions-and-verification)). | As QUEUE-01. | 1. `/new`. | Record what happens to `x`. | — |

## conversation/shell-commands.md

| ID | P | Device | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SHELL-01 | P1 | keyboard | `!echo hello` shows a box with `$ echo hello` and `hello` ([The simple case](../conversation/shell-commands.md#the-simple-case)). | `--no-env`. | 1. Type `!echo hello`, Enter. | As stated; the editor empties. | pass (driver) |
| SHELL-02 | P1 | keyboard | The border turns green when the text starts with `!` ([Compose](../conversation/shell-commands.md#compose)). | Any. | 1. Type `!`. | Green border; removing `!` restores the thinking colour. | — |
| SHELL-03 | P1 | keyboard | A running command shows a spinner reading `Running... (escape/ctrl+c to cancel)` ([Sent](../conversation/shell-commands.md#sent)). (suspected copy bug) | `--no-env`. | 1. `!sleep 30`. | The spinner line with exactly that text. | pass (driver) |
| SHELL-04 | P1 | keyboard | Escape kills the command and the box shows `(cancelled)` ([Cancel and interrupt](../conversation/shell-commands.md#cancel-and-interrupt)). | As SHELL-03. | 1. Press Escape. | `(cancelled)`; `ps` shows no `sleep 30`. | pass (driver, screen only) |
| SHELL-05 | P1 | keyboard | Ctrl+C does not cancel a running command ([Cancel and interrupt](../conversation/shell-commands.md#cancel-and-interrupt)). | `!sleep 30` running. | 1. Press Ctrl+C once. | The command keeps running; the editor clears. | — |
| SHELL-06 | P1 | keyboard | A bare `!` is sent to the model as a prompt (suspected bug) ([Resolves at once](../conversation/shell-commands.md#resolves-at-once)). | `--no-env`. | 1. Type `!`, Enter. | The no-credential error (proof it went to the model path); with a credential, a user message `!`. | pass (driver) |
| SHELL-07 | P1 | keyboard | A second `!` while one runs is refused with `A bash command is already running. Press Esc to cancel it first.` and the text stays ([Resolves at once](../conversation/shell-commands.md#resolves-at-once)). | `!sleep 30` running. | 1. Type `!ls`, Enter. | The warning; `!ls` still in the editor. | — |
| SHELL-08 | P2 | keyboard | More than 20 output lines collapse with `... N more lines (ctrl+o to expand)` ([Done](../conversation/shell-commands.md#done)). | `--no-env`. | 1. `!seq 1 30`. | The last 20 lines and `... 10 more lines (ctrl+o to expand)`; Ctrl+O shows all. | — |
| SHELL-09 | P2 | keyboard | A non-zero exit shows `(exit N)` ([Done](../conversation/shell-commands.md#done)). | `--no-env`. | 1. `!exit 3`. | `(exit 3)`. | — |
| SHELL-10 | P2 | keyboard | `!!` draws a dim border and its header turns green after output (suspected cosmetic bug) ([Edge cases](../conversation/shell-commands.md#edge-cases)). | `--no-env`. | 1. `!!echo hi`. | Record the border and header colours. | — |
| SHELL-11 | P1 | model | The record reaches the model on the next turn in the `Ran \`cmd\`` form; `!!` does not ([Done](../conversation/shell-commands.md#done)). | One credential. | 1. `!echo SECRET1`; `!!echo SECRET2`; send `What did the last shell commands print?`. | The answer mentions SECRET1 and not SECRET2. | — |
| SHELL-12 | P1 | model | A command started while working goes to the pending area and disappears at the next queue change (suspected bug) ([Open questions](../conversation/shell-commands.md#open-questions-and-verification)). | One credential. | 1. Send a long prompt; `!echo hi`; then type `x` and press Enter. | Record whether the `$ echo hi` box is still on screen after step 3 and whether it ever enters the transcript. | — |
| SHELL-13 | P2 | keyboard | Shell records appear in `/tree` as `[bash]: cmd` ([Interactions with other systems](../conversation/shell-commands.md#interactions-with-other-systems)). | `--no-env`. | 1. `!echo hi`; `/tree`. | A `• [bash]: echo hi` row. | pass (driver) |
| SHELL-14 | P2 | keyboard | Output over 2000 lines is truncated and names a temp file ([Done](../conversation/shell-commands.md#done)). | `--no-env`. | 1. `!seq 1 3000`. | `Output truncated. Full output: /tmp/pi-bash-….log`. | — |

## conversation/attachments.md

| ID | P | Device | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ATTACH-01 | P1 | clipboard | Ctrl+V with an image on the clipboard inserts a `pi-clipboard-….png` path ([Compose](../conversation/attachments.md#compose)). | Copy a screenshot. | 1. Press Ctrl+V in the editor. | The temp path appears at the cursor; the file exists. | — |
| ATTACH-02 | P2 | clipboard | Ctrl+V with text inserts the text ([Compose](../conversation/attachments.md#compose)). | Copy some text. | 1. Press Ctrl+V. | The text is inserted; no paste marker even for 20 lines. | — |
| ATTACH-03 | P1 | model, images | A `read` of a PNG shows the image inline ([While working](../conversation/attachments.md#while-working)). | Kitty or Ghostty; an image model. | 1. Paste an image path; send `What is in this image?`. | A `read` box with the image drawn; the answer describes it. | — |
| ATTACH-04 | P1 | model | `pi @file.md "Summarise"` inlines the file ([Compose](../conversation/attachments.md#compose)). | A text file. | 1. Run the command. | The user message contains `<file name="…">` with the content; a summary follows. | — |
| ATTACH-05 | P2 | keyboard | A missing `@file` argument is a red error and exit ([Compose](../conversation/attachments.md#compose)). | None. | 1. `pi @nope.txt`. | `Error: File not found: …`; exit 1. | — |
| ATTACH-06 | P2 | keyboard | A dropped file path gets a space before it after a word ([Compose](../conversation/attachments.md#compose)). | Any. | 1. Type `see`; drop a file. | `see /path/to/file`. | — |

## conversation/thinking.md

| ID | P | Device | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| THINK-01 | P1 | model | Shift+Tab cycles levels, updates the footer and border, and prints `Thinking level: <level>` ([Open](../conversation/thinking.md#open)). | A reasoning model. | 1. Press Shift+Tab repeatedly. | Levels advance in order and wrap; the border colour changes each time. | — |
| THINK-02 | P1 | keyboard | `/thinking` opens the overlay with `Enter to select · Ctrl+S to set as default · Esc to cancel` ([Open](../conversation/thinking.md#open)). | Any. | 1. `/thinking`. | As stated. | pass (driver: `off  No reasoning` on the placeholder model) |
| THINK-03 | P2 | model | `/thinking bogus` errors with the available levels ([Open](../conversation/thinking.md#open)). | Any model. | 1. `/thinking bogus`. | `Error: Unknown thinking level "bogus". Available levels: …`. | — |
| THINK-04 | P1 | model | Ctrl+T hides thinking everywhere and persists ([Accepted](../conversation/thinking.md#accepted)). | A session with thinking shown. | 1. Press Ctrl+T; quit; restart. | Every thinking block is one `Thinking...` line; still hidden after restart; `hideThinkingBlock: true` in settings. | — |
| THINK-05 | P2 | model | Ctrl+S in the overlay saves `defaultThinkingLevel` ([Accepted](../conversation/thinking.md#accepted)). | Any model. | 1. `/thinking`; choose `low` with Ctrl+S. | `Default thinking level: low`; the setting in the file. | — |

## conversation/the-transcript.md

| ID | P | Device | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TRANS-01 | P1 | model | Markdown renders: headings, lists, code blocks indented two spaces and highlighted, tables ([What each thing looks like](../conversation/the-transcript.md#what-each-thing-looks-like)). | One credential. | 1. Send `Show a heading, a bullet list, a JSON code block, and a 2x2 table`. | Each renders as described. | — |
| TRANS-02 | P1 | model | Ctrl+X copies the last answer and prints `Copied last agent message to clipboard` ([Ctrl+O, Ctrl+T, and copying](../conversation/the-transcript.md#ctrlo-ctrlt-and-copying)). | Clipboard available. | 1. After an answer press Ctrl+X; paste elsewhere. | The status; the answer text pastes. | — |
| TRANS-03 | P2 | keyboard | Ctrl+X with no answer yet errors `No agent messages to copy yet.` ([Ctrl+O, Ctrl+T, and copying](../conversation/the-transcript.md#ctrlo-ctrlt-and-copying)). | Fresh session. | 1. Press Ctrl+X. | The error. | — |
| TRANS-04 | P2 | model | A mermaid block renders as a box diagram while streaming ([What each thing looks like](../conversation/the-transcript.md#what-each-thing-looks-like)). | One credential. | 1. Send `Draw a two-node mermaid flowchart`. | Unicode boxes and arrows, not the source. | — |
| TRANS-05 | P2 | keyboard | `/hotkeys` prints a box-drawn table ([What each thing looks like](../conversation/the-transcript.md#what-each-thing-looks-like)). | Any. | 1. `/hotkeys`. | A table with `Ctrl+G`, `Option+Enter`, `/`, `!`, `!!` rows. | pass (driver) |
| TRANS-06 | P2 | model | A rebuild (Ctrl+T) drops status lines and errors ([Interactions with other systems](../conversation/the-transcript.md#interactions-with-other-systems)). | A session with a status line visible. | 1. Press Ctrl+T. | The status line is gone; messages remain. | — |

Not checkable by hand:

- The exact colour values of the thinking-level border ramp (P3; compare by eye only).
