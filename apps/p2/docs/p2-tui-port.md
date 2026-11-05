# Porting pi's interactive TUI to p2

Goal: when an existing pi user opens p2's TUI (`npm run tui`), it should look and behave like pi's coding agent
(`packages/coding-agent`, interactive mode), wherever that makes sense for a server-backed, multi-user, sandboxed app.
This is not a feature-parity checklist. The guide lists every user-facing feature of pi's TUI, says how p2 gets each
one, and gives the designs and the work plan for the port. Sections 1–9 are the porting design; where the build
differs, the "As built" sections of section 10 describe the code.

Notation:

- **(a) copy**: copy the source into p2 (usually `apps/p2/src/tui/` or a plugin's `tui.ts`) and strip what section 11
  lists. p2 must not import `packages/coding-agent` at runtime. `@earendil-works/pi-tui` as a library is fine.
- **(b) Chord**: re-implement on Chord objects. The table names the object or contract that supplies the data,
  marked **new** when it does not exist yet.
- **(c) skip**: not applicable, with the reason. **(d) deferred**: applicable, scheduled late.
- **L:** a launcher action under a launcher grant (section 3). **G:** a guest-local preference (section 4).

Path aliases. Every pointer starts with one of these or a repo-root path:

| Alias | Path |
| --- | --- |
| `CA` | `packages/coding-agent/src` |
| `IM` | `packages/coding-agent/src/modes/interactive/interactive-mode.ts` |
| `CMP` | `packages/coding-agent/src/modes/interactive/components` |
| `THM` | `packages/coding-agent/src/modes/interactive/theme` |
| `REN` | `packages/coding-agent/src/core/tools/renderers` |
| `TUI` | `packages/tui/src` |
| `ENV` | `packages/env` |
| `DUR` | `packages/durable/src` |
| `P2` | `apps/p2` |

`IM`, `CMP`, `THM`, `REN` and `TUI` line numbers refer to coding-agent and pi-tui as of the port; p2 code is named by
file and symbol. Section 2 maps where the port lives in p2.

---

## 1. Feature inventory and how p2 gets each

### 1.1 Layout, header, footer, renderer

| Feature | coding-agent pointer | p2 route |
| --- | --- | --- |
| Two renderers: regular (main screen, scrollback) and fullscreen (alt screen with own scroll, search, selection), switchable at runtime | `IM:873` mountInteractiveTui, `IM:890` switchTuiMode, `CA/modes/interactive/tui-renderer.ts:22` | Fullscreen only, as a **product decision**. Regular mode is technically possible: the filter passes text, cursor and erase sequences (`P2/src/hosts/tui-filter.ts:5-13`, `:49`). But in regular mode a worker swap (reload) re-renders the transcript below the old scrollback. That duplicates content unless the new worker restores `TuiMainScreen.captureRenderState` from the snapshot. If regular mode comes later, the reload state must carry that render state. |
| Fullscreen layout: transcript `ScrollView` above a fixed dock (pending, status, widgets, editor, widgets, footer) | `CA/modes/interactive/chat-viewport.ts:22-45`, `IM:968-991` | (a) copy `CA/modes/interactive/chat-viewport.ts` (as built: `ChatSurface.layout`, `P2/plugins/chat/tui.ts`). |
| Transcript scroll keys (page, half page, line, top/bottom, prompt jumps), "Jump to latest" indicator | `TUI/keybindings.ts:160-210`, `CA/modes/interactive/tui-renderer.ts:30-34` | (a) Use pi-tui's built-in keys. |
| Transcript search | `TUI/tui-alt-screen.ts:168` options, `CA/modes/interactive/tui-renderer.ts:25-29` | (a) Free with `TuiAltScreen`; pass themed styles. Key precedence: section 6.2. |
| Mouse: wheel, selection, copy-on-select, right-click paste, clickable logo | `CA/modes/interactive/tui-renderer.ts:35-46`, `IM:256` | Wheel and selection: (b), behind a **G** mouse policy plus launcher mode ownership (section 3.6). Copy is **L:copy**; right-click paste is **L:paste**. Easter eggs are (c). |
| Startup header: logo, version, key hints (Ctrl+O toggles compact/expanded), onboarding line | `IM:1009-1075`, `CMP/pi-logo.ts:19` | (a) Hints come from the command registry (section 6). Show the server origin and the role (owner/guest) in place of the version. |
| Loaded-resources listing | `IM:1772` | (d) Owner only: **new** resources view (AGENTS.md and skills from `P2/plugins/prompt/worker.ts`, enabled plugins). |
| Changelog / update notices | `IM:843`, `IM:4647`, `IM:4679` | (c) Server releases are not pi releases. Reuse the slot for owner notices. |
| Footer line 1: cwd, git branch, session name | `CMP/footer.ts:165-177` (session name `:174-177`), rendered at `:286` | (b) `Sessions.sessions` gives title, env and cwd. The branch comes from `Workspace.query({kind:"status"})`, participant only. Guests in view mode get no branch. |
| Footer line 2: tokens, cache rate, cost, context %, model and thinking | `CMP/footer.ts:179-212` stats, `:220-284` model side | (b) Data provenance in section 1.16. |
| Footer line 3: extension statuses | `CMP/footer.ts:290-299` | (b) `TuiFooter` registry (section 7). |
| Terminal title | `IM:1132` | **L:title** (section 3). |
| Progress / program status | `CA/modes/interactive/program-status-reporter.ts:17`, `TUI/terminal.ts:571` setTitle, `:576-584` setProgramStatus, `:587-600` setProgress | **L:progress**, gated by **G** `terminal.showTerminalProgress`. |

### 1.2 Editor and input

| Feature | Pointer | p2 route |
| --- | --- | --- |
| Multi-line editor: kill ring, undo, word motion, jump-to-char, newline | `TUI/components/editor.ts:297`, `TUI/keybindings.ts:71-158` | (a) Already used. |
| Mouse editing / cursor placement in the editor | `TUI/components/editor.ts:655-693` | (b) Requires mouse mode (section 3.6). |
| `CustomEditor`: `onAction`, Escape/Ctrl+D handlers, paste-image hook, extension shortcuts, embedded working status | `CMP/custom-editor.ts:13`, `:84`, `:90-140` | (a) Copy, wired to the command dispatcher (section 6). The paste-image hook is removed: that key is launcher-owned. |
| Border color by thinking level; bash-mode color for `!` | `IM:4528`, `IM:3125` | (a) |
| Prompt history | `TUI/components/editor.ts:345-490` | (a) Seed it from the transcript's own user items, like `populateHistory` (`IM:3975`). Secret prompts never enter history (1.8). |
| Paste markers `[paste #1 +N lines]` | `TUI/components/editor.ts:1309`, `:1092` | (a) Free; bracketed paste is allowed. |
| Slash autocomplete with argument completion | `IM:725`, `TUI/autocomplete.ts:314` | (b) Fed by `TuiCommands` (section 6). Never instantiate `CombinedAutocompleteProvider`: it calls `readdirSync`/`statSync`/`spawn` (`TUI/autocomplete.ts:1-3`). |
| `@file` fuzzy completion | `TUI/autocomplete.ts:149-240`, `:772`, `:503` | (b) **new** `FileIndex` (section 8). |
| Tab path completion (`~`, absolute, parent) | `TUI/autocomplete.ts:520`, `:549-588` (homedir/statSync), `:600-680`, `:850-859` | (b) Cwd-relative only in p2 (section 8.2). |
| Extension autocomplete providers | `IM:825` | (b) `TuiCompletions`, keyed by provider id (section 7). |
| Ctrl+V clipboard paste (files, image, text) | `IM:3152`, `CA/utils/clipboard-image.ts:200` | **L:pasteImage**, launcher-matched (section 3). |
| Drag & drop files | `IM:1047` (the terminal pastes paths) | **L:attach** with trusted consent (section 3.3). |
| External editor | `IM:4608`, `CA/modes/interactive/external-editor.ts:14-46` (`editInExternalEditor`), `CA/core/settings-manager.ts:946` | **L:externalEditor**, launcher-matched; the command is **G** and never sent to the worker. |
| Ctrl+C clear / double Ctrl+C exit / Ctrl+D exit on empty editor | `IM:4281`, `IM:4291`, `CMP/custom-editor.ts:118` | (a) As pi (10.1). |
| Ctrl+Z suspend | `IM:4450` | **L:suspend**, launcher-matched. |
| `!cmd` / `!!cmd` user bash | `IM:3346-3360`, `IM:6999`, `CMP/bash-execution.ts:21` | (d) **new** `Chat.shell` (participant, streamed through a live slot or an entry). |

### 1.3 Message rendering

| Feature | Pointer | p2 route |
| --- | --- | --- |
| User message (Markdown on `userMessageBg`; OSC 133 zone markers) | `CMP/user-message.ts:13`, `:49-50` | (a) Plus p2 data from `buildTranscript` items (`P2/src/web/transcript.ts`): author label with the guest "unverified name" note, peer attribution, reply quote, plugin note, files and image count. |
| Assistant message: ordered text/thinking, hidden-thinking label, error/abort/length notices | `CMP/assistant-message.ts:14`, `:58`, `:91`, `:142-168` (thinking blocks), `:185-198` | (a) `AssistantMessageComponent` (`P2/src/tui/components/messages.ts`), streamed with `updateContent(message, true)` by `AssistantView` (`P2/src/tui/components/transcript.ts`). |
| Per-thinking-block and per-card expansion (click) | `CMP/assistant-message.ts:142-168`, `CMP/tool-execution.ts:162-167` | (b) With mouse mode; otherwise global Ctrl+T/Ctrl+O. |
| Markdown + syntax highlighting; code-block indent | `THM/theme.ts:1022` getMarkdownTheme, `THM/theme.ts:930` highlightCode | (a) Port highlighting to `lowlight` (already a p2 dep, `P2/src/web/Code.tsx`). `markdown.codeBlockIndent` is **G**. Watch the 8 MiB bundle cap (`P2/src/hosts/tui-sandbox.ts:3`). |
| Mermaid | `CMP/mermaid.ts:1-5`, `:60-88` | (d) Pure rendering (grok-mermaid). Mode `markdown.mermaid` is **G**. Lands as an ordered Markdown transformer (section 7). |
| Skill invocation block | `CMP/skill-invocation-message.ts:11`, `IM:3945-3953` | (d) With `/skill:` (1.10). |
| Custom messages / entries | `CMP/custom-message.ts:12`, `CMP/custom-entry.ts:11`, `IM:3858` | (b) `TuiEntryRenderers` by entry kind (section 7). |
| Compaction summary | `CMP/compaction-summary-message.ts:10` | (a) Data: the `pi.compaction` entry. |
| Branch summary | `CMP/branch-summary-message.ts:10` | (c) Until p2 has branch navigation. |
| Reset marker | — | (a) `pi.reset` plus its handoff text (`MarkerView`, `P2/src/tui/components/transcript.ts`). |
| Cache-miss / warming / thinking-dropped / compaction-cost notices | `IM:4122-4210` | (b) Cost notices from `pi.usage`. Cache warming is server state (1.14). |
| Status lines (consecutive lines collapse), errors, warnings | `IM:3836`, `IM:4635`, `IM:4641` | (a) `StatusLines` in the dock (`P2/src/tui/components/chrome.ts`; 10.1). |
| Nested codemode calls | `IM:3607` | (b) `docs["p2.nested-calls"]` (`P2/plugins/chat/contract.ts:182`). |

### 1.4 Tool call/result rendering

The generic card is `CMP/tool-execution.ts:31`:

- Backgrounds for pending/success/error, set in `updateDisplay` (`CMP/tool-execution.ts:270-276`).
- Fallbacks (`CMP/tool-execution.ts:142-159`).
- Expansion (`CMP/tool-execution.ts:202`) and the render context (`CMP/tool-execution.ts:120`).
- Lifecycle methods `updateArgs`, `markExecutionStarted`, `setArgsComplete` and `updateResult` (`CMP/tool-execution.ts:170-187`).
- Images (`CMP/tool-execution.ts:354`).

Renderers are combined at `REN/index.ts:32`.

| Tool | Pointer | p2 route |
| --- | --- | --- |
| Generic fallback | `CMP/tool-execution.ts:23`, `:142-159` | (a) Section 11 checklist. |
| `bash`/`powershell` | `REN/bash.ts`, `CMP/visual-truncate.ts:69` | (a) Map Durable details (`DUR/tools/bash.ts:130` `fullOutputPath`). |
| `read` | `REN/read.ts` | (a) Strip `getReadmePath` and local path resolution (section 11). |
| `write` | `REN/write.ts` | (a) |
| `edit` (word diff; pre-execution preview) | `REN/edit.ts:173-252`, `CMP/diff.ts:79` | (a) `renderDiff` needs the `diff` package, pinned. Drop the local preview (`computeEditsDiff` reads the local fs, `REN/edit.ts:189`). Use `details.diff` (`DUR/tools/edit.ts:127-137`). |
| `grep`/`find`/`ls` | `REN/grep.ts`, `REN/find.ts`, `REN/ls.ts` | (a) For subagent/MCP tools; Durable's coding tools are read/write/edit/bash. |
| p2 tools: artifact, send_file, subagent, ports, reload_plugins | web `P2/src/web/Chat.tsx:164-302` | (b) Plugin renderers (section 7). |
| Images | `CMP/tool-execution.ts:354`, `TUI/components/image.ts:103` | (d) Text placeholders now (`P2/src/hosts/tui-worker-runtime.ts:103`). A later launcher-rendered image is described in section 3. |
| Expand all (Ctrl+O) | `IM:4569-4590` | (a) |

### 1.5 Working indicators

| Feature | Pointer | p2 route |
| --- | --- | --- |
| Spinner in the editor border; `setWorkingMessage/Visible/Indicator` | `CMP/status-indicator.ts:9`, `:38`, `IM:2346-2380` | (a) Text derived from `pi.live` (`ChatSurface.syncIndicator`, `P2/plugins/chat/tui.ts`; indicators in `P2/src/tui/components/status.ts`). |
| Retry countdown (Esc aborts) | `CMP/status-indicator.ts:51`, `CMP/countdown-timer.ts:7`, `IM:3744` | (a)+(b) `live.generation.retry`; Esc runs `Chat.stop`. |
| Compaction indicator (Esc aborts) | `CMP/status-indicator.ts:85`, `IM:3672` | (a)+(b) Needs **new** `Chat.abortCompaction` (P3 contract before the P4 UI). |
| Hidden-thinking label, idle status | `IM:2382`, `CMP/status-indicator.ts:114` | (a) |

### 1.6 Themes

| Feature | Pointer | p2 route |
| --- | --- | --- |
| `Theme` class | `THM/theme.ts:185-373` | (a) Instance design (section 5). Do not copy `THM/theme.ts:375-391` (built-ins read from disk). |
| Tokens, schema, built-ins, system theme | `THM/theme-tokens.ts:24`, `THM/theme-schema.ts:52`, `:97`, `THM/dark.json`, `THM/light.json`, `THM/system-theme.ts:465` | (a) Built-ins are imported as JSON into the bundle. |
| Terminal color query and scheme notifications | `THM/theme-controller.ts:31`, `TUI/tui.ts:1494`, `:961` | **L:terminalColors** (the launcher queries; the worker gets data). |
| Custom theme discovery and loading | `THM/theme.ts:436` getCustomThemeInfos, `THM/theme.ts:487` loadThemeJson, `THM/theme.ts:734` startThemeWatcher; `THM/theme.ts:672` registers already-loaded themes into `registeredThemes` (declared `:670`); `CA/config.ts:614` | **G** The launcher reads and watches the files and posts validated JSON. |
| Theme picker with preview; light/dark pair | `CMP/theme-selector.ts:13`, `THM/theme.ts:578` | (a) Saving goes through **L:savePrefs** with trusted confirmation. |

### 1.7 Models and thinking

| Feature | Pointer | p2 route |
| --- | --- | --- |
| Model selector: search, all/scoped toggle (Tab), current and default badges, Ctrl+S make default, background catalog refresh with progress and timeout | `CMP/model-selector.ts:40`, `:94`, `:137-158`, `:184-218`, `:262-296`, `:362-403`; `IM:5354`, `IM:5206` | (a) Section 11 checklist: inject data and actions instead of `ModelRuntime`. Data: `Models.models` and `Models.defaultModel`. "Refresh" uses `ProviderLogin.refresh` per provider. Owner only: `Models` refuses non-owners (`P2/plugins/models/server.ts:62-64`) and `Chat.configure` is owner-only (`P2/plugins/chat/worker.ts:269-272`). Guests see the model read-only. |
| Exact `/model provider/id` | `IM:5229` | (a) |
| Scoped models, Ctrl+P cycling | `CMP/scoped-models-selector.ts:97`, `IM:5390`, `IM:4550` | (b) **new** `enabledModels` in `P2/src/runtime/settings.ts`, exposed by `Models` (contract in P3, UI in P4). |
| Thinking selector, Shift+Tab, save as default | `CMP/thinking-selector.ts:36`, `IM:4539`, `IM:5185` | (a) `Chat.configure` / `Models.setDefault`; owner only. |
| Per-model default thinking (`modelThinkingLevels`) | `packages/coding-agent/docs/settings.md:16` | (b) Server setting; read-only display. |

### 1.8 Login / logout

| Feature | Pointer | p2 route |
| --- | --- | --- |
| `/login [provider]`: auth type and provider selectors | `IM:5863`, `IM:5897`, `CMP/oauth-selector.ts:58` | (a) Data: `ProviderLogin.providers` (`P2/plugins/login/contract.ts`), owner only. |
| OAuth dialog: URL, device code, manual code, progress, cancel | `CMP/login-dialog.ts:12`, `CMP/auth-url.ts:10`, `IM:6290-6298`, `IM:6314` | (a) Remove auto-open (`CMP/login-dialog.ts:3`, `:99-110`) and the native clipboard and platform hints (`CMP/auth-url.ts:2`, `:26-34`). The URL is displayed as text. Opening it is **L:openUrl** (external kind) and copying it is **L:copy**. Both are launcher-confirmed. |
| Prompted values (API key, codes) | pi: plain `Input` (`IM:6295-6297` → `CMP/login-dialog.ts:58-63`), with the submitted value echoed as `> ${value}` (`CMP/login-dialog.ts:80-83`) | **p2 improvement, not pi parity.** For `prompt.type === "secret"`, use a secret-mode input that masks characters and does not echo the submitted value. The value is excluded from history, from the reload snapshot (`P2/src/hosts/tui-worker-runtime.ts:118`) and from status lines. The web already masks (`P2/plugins/login/web.tsx:130`). |
| `/logout`, refresh | `IM:6018`, `IM:6078` | (b) `ProviderLogin.logout` / `refresh`. |
| Ambient auth, subscription warning, Radius offer | `IM:6174`, `IM:5273`, `IM:6389` | (c) Show `ProviderLogin` notices. |

### 1.9 Sessions

| Feature | Pointer | p2 route |
| --- | --- | --- |
| `/resume` selector | `CMP/session-selector.ts:694`, `CMP/session-selector-search.ts:39-153`, `IM:5720` | (a) UI with the documented adaptations in section 1.17. Data: `Sessions`, `Search`, `SessionStatus`. |
| `/new` | `IM:6938` | (b) `Sessions.create({cwd, env})`. A separate `/new-context` uses **new** `Chat.reset(handoff?)` (`DUR/harness/types.ts:642`). |
| `/name` | `IM:6680` | (b) `Sessions.rename`. pi distinguishes an explicit session name; p2 rows have only `title` (`P2/plugins/sessions/contract.ts:9-20`). |
| `/session` | `IM:6705` | (b) Section 1.16 provenance. |
| `/tree`, `/fork`, `/clone`, double-Esc action | `CMP/tree-selector.ts:1336`, `CMP/user-message-selector.ts:110`, `IM:5571`, `IM:5512`, `IM:5550`, `IM:3070-3093` | (b) `/tree` and double-Esc on Durable forks (`docs/tree.md`); (d) `/fork` and `/clone` via **new** `Sessions.fork` (`DUR/harness/types.ts:663`). |
| `/export`, `/import` | `IM:6532`, `IM:6579` | (c) |
| `/share` | `IM:6623` | p2 sharing overlay (`P2/plugins/sharing/contract.ts:90`). |
| `/compact [instructions]` | `IM:7092` | (b) **new** `Chat.compact` (`DUR/harness/types.ts:647`). |
| Subagent conversations | — | (b) `Subagents`, keyed by (session, conversation) identity; `/agents` and the subagent card in `P2/plugins/subagents/tui.ts`. |

### 1.10 Slash commands

Built-ins come from `CA/core/slash-commands.ts:19-44`; hidden ones are handled in `IM:3199-3397`. A command is
registered only in the phase that implements it (section 10). Example: `/copy` appears in P5, not before.

| Command | p2 route |
| --- | --- |
| `/settings` | Overlay: guest UI prefs (section 4) plus a read-only view of server settings for the owner. |
| `/model`, `/thinking`, `/scoped-models` | 1.7 |
| `/export`, `/import`, `/bug`, `/changelog`, `/trust`, `/debug`, `/arminsayshi`, `/dementedelves` | (c) |
| `/share` | Sharing overlay |
| `/copy` | **L:copy** with trusted confirmation (section 3.2) |
| `/name`, `/session`, `/new`, `/resume`, `/compact` | 1.9 |
| `/hotkeys` | Help overlay generated from the registry (layout of `IM:6821`) |
| `/fork`, `/clone` | (d) |
| `/login`, `/logout` | 1.8 |
| `/reload` | Re-fetch the TUI bundle (`p2.tui.reload`, unbound). The owner additionally gets the dev plugin reload. |
| `/quit` | exit |
| Prompt templates, `/skill:<name>` | (d) Needs a listing object. |
| Extension commands | `TuiCommands` |
| p2-only | `/sessions`, `/chat-mode`, `/artifacts`, `/providers`, `/envs`, `/devices`, `/logs`, `/ports`, `/new-context`, `/agents`, `/files`, `/changes` (section 9) |

### 1.11 Keybindings

Defaults:

- `TUI/keybindings.ts:71-210` (`tui.*`).
- `CA/core/keybindings.ts:25-171` (`app.*`).
- Platform overrides at `CA/core/keybindings.ts:180-199`, using `useWindowsKeybindings` (`CA/core/keybindings.ts:16`).
- Legacy name migration at `CA/core/keybindings.ts:201-261`.

The config file is `~/.pi/agent/keybindings.json` (`CA/core/keybindings.ts:338`, `packages/coding-agent/docs/keybindings.md`).
Conflicts are only detected among user overrides (`TUI/keybindings.ts:243-262`).

| pi id | default | p2 |
| --- | --- | --- |
| `app.interrupt` | Esc | same id |
| `app.clear` | Ctrl+C | same id |
| `app.exit` | Ctrl+D on an empty editor | same id, empty editor only |
| `app.suspend` | Ctrl+Z | launcher-owned |
| `app.thinking.cycle` / `.toggle` / `.save` | Shift+Tab / Ctrl+T / Ctrl+S (selector) | same ids |
| `app.model.cycleForward` / `.cycleBackward` / `.select` | Ctrl+P / Shift+Ctrl+P / Ctrl+L | same ids |
| `app.tools.expand` | Ctrl+O | same id |
| `app.editor.external` | Ctrl+G | launcher-owned |
| `app.message.copy` | Ctrl+X | launcher-owned |
| `app.message.followUp` / `.dequeue` | Alt+Enter / Alt+Up | same ids |
| `app.clipboard.pasteImage` | Ctrl+V | launcher-owned |
| `app.session.new/tree/fork/resume` | unbound | same ids, unbound like pi; `p2.sessions` keeps Ctrl+R in the chat context |
| selector-local `app.session.*`, `app.tree.*`, `app.models.*` | various | same ids, scoped to their overlay context |
| — | — | `p2.tui.reload`, unbound (`/reload`); transcript scrolling uses `tui.altScreen.*` |

### 1.12 Extension UI hooks

`ExtensionUIContext` is `CA/core/extensions/types.ts:149-300`, implemented at `IM:2633`. Extensions themselves are
(c): p2 plugins are server-selected and bundled. Each hook maps to a plugin contribution (section 7).

| Hook | Pointer | p2 |
| --- | --- | --- |
| `select`/`confirm`/`input`/`editor` dialogs with `timeout` and `signal` | `CA/core/extensions/types.ts:113-118`, `:151-157`, `:240`; `IM:2690`, `IM:2750`, `IM:2773`, `IM:2831`; `CMP/extension-selector.ts:19`, `CMP/extension-input.ts:18`, `CMP/extension-editor.ts:26` | `ctx.dialog.*` with the same `{timeout, signal}` options and a countdown. `extension-editor` loses its external-editor path (section 11). |
| `notify` | `IM:2955` | `ctx.notify` (also fed by `LogNotices`) |
| `onTerminalInput` | `IM:2592` | (c) No raw interception beyond the command dispatcher. |
| `setStatus` | `IM:2300` | `TuiFooter` |
| `setWorking*`, `setHiddenThinkingLabel` | `IM:2346-2396` | `ctx.working` |
| `setWidget` | `IM:2398`, `IM:2491` | `TuiSlots` `widget-above:*` / `widget-below:*` |
| `setFooter`, `setHeader` | `IM:2524`, `IM:2551` | `TuiSlots` `footer` / `header`; runtime fallbacks (section 7) |
| `setTitle` | `CA/core/extensions/types.ts:211` | through **L:title** |
| `custom()` overlays: sizing/positioning (`overlayOptions`, possibly dynamic), `onHandle` lifecycle | `CA/core/extensions/types.ts:214-228`, `IM:2966` | `ctx.overlay(factory, {overlayOptions, onHandle})` on pi-tui's overlay stack. Handles are disposed on navigation, reload and plugin replacement. |
| editor text access, `addAutocompleteProvider` | `CA/core/extensions/types.ts:231-243` | `ctx.editor`, `TuiCompletions` |
| `setEditorComponent` / `getEditorComponent` | `CA/core/extensions/types.ts:278-281`, `IM:2875` | (c) Decision: one editor. Plugins add widgets. |
| theme access | `CA/core/extensions/types.ts:287-293` | `ctx.theme` read-only; changes only through prefs |
| tools expanded | `CA/core/extensions/types.ts:296-299` | `ctx.view.expandedTools` |
| `registerShortcut` | `IM:2241` | `TuiCommands` |
| `registerMessageRenderer` / `registerEntryRenderer` | `CA/core/extensions/types.ts:1687`, `:1693` | `TuiEntryRenderers` |
| `registerMarkdownTransformer` | `CA/core/extensions/types.ts:1690`, `:1519` | **ordered** `TuiMarkdownTransformers` (section 7) |
| `registerToolRenderer(resolver)` with `next()` | `CA/core/extensions/types.ts:664-667`, `:1696` | **ordered** `TuiToolRendererResolvers` plus the per-name `TuiToolRenderers` (section 7) |

### 1.13 Queue, abort, retry, notifications, misc

| Feature | Pointer | p2 route |
| --- | --- | --- |
| Enter steers while busy; Alt+Enter follows up | `IM:3376-3384`, `IM:4487` | (b) Exists (`P2/plugins/chat/tui.ts:87`). |
| Pending area with dequeue hint | `IM:4735` | (a) `buildTranscript(...).queued` (`P2/src/web/transcript.ts:107`, `:569-580`). |
| Alt+Up restores all queued messages | `IM:4519`, `IM:4754` | (b) **new** `Chat.dequeueOwn`. Client-side selection is impossible: `queued` carries no author, and `Chat.dequeue` withdraws an item before checking its author. Other authors' items are moved to their drafts (`P2/plugins/chat/worker.ts:237-242`, `:263-267`). Contract: server-side, atomically select the caller's queued inputs by the server-stamped author, in submission order. Withdraw only those and return their texts in order. Items placed or withdrawn concurrently are skipped and reported as `{restored, skipped}`. |
| Esc while streaming | `IM:3070` | (b) `Chat.stop` (returns the caller's own texts). |
| Drafts withdrawn by others | — | (b) Exists (`P2/plugins/chat/tui.ts:65-79`), keyed per (session, conversation) after P0. |
| Auto-retry | `IM:3744-3770` | (b) |
| Notifications | `IM:4635-4700` | (b) Status lines plus `LogNotices` |
| Copy last message / selection | `IM:6649` | **L:copy** |
| Terminal capabilities: kitty protocol, modifyOtherKeys, images, hyperlinks, true color | `TUI/terminal.ts:222-330`, `TUI/keys.ts:31` setKittyProtocolActive, `TUI/terminal-image.ts:187` setCapabilityOverrides, `:167` getCapabilities | Bug: the launcher's `ProcessTerminal` negotiates kitty, but `BridgeTerminal.kittyProtocolActive` stays false (`P2/src/hosts/tui-worker-runtime.ts:26`). Nobody calls `setKittyProtocolActive` in the worker. Fixed by the `capabilities` message (section 3.5). |
| Exit and terminal restore | `IM:4303`, `IM:4400`, `IM:7102` | Launcher (`P2/src/hosts/tui-client.ts:201-209`), extended in section 3.6. |
| First-time setup, trust selector, image selector, config selector | `CMP/first-time-setup.ts:33`, `CMP/trust-selector.ts:32`, `CMP/show-images-selector.ts:13`, `CMP/config-selector.ts:875` | (c) |

### 1.14 Settings and interaction details

From `CMP/settings-selector.ts:60-101` (config), `:482-865` (items) and
`packages/coding-agent/docs/settings.md:13-21`, `:31-44`, `:72-88`, `:94-115`, `:123-143`.
Nested keys are shown as pi spells them.

| pi setting | Kind in p2 | Notes |
| --- | --- | --- |
| `theme`, `quietStartup`, `editorPaddingX`, `outputPad`, `autocompleteMaxVisible`, `showHardwareCursor`, `hideThinkingBlock`, `doubleEscapeAction` | **G** | `doubleEscapeAction`: `tree` (default, `docs/tree.md`), `fork`, `none` |
| `terminal.clearOnShrink`, `terminal.showTerminalProgress`, `terminal.showImages`, `terminal.imageWidthCells`, `terminal.hyperlinks`, `terminal.images`, `terminal.trueColor` | **G** | Image protocol selection only matters once launcher images exist. Hyperlinks need the URL policy (section 3.4). |
| `markdown.codeBlockIndent`, `markdown.mermaid` | **G** | |
| `tuiMode` | (c) fullscreen only (1.1) | |
| `fullscreenExitOutput` (`transcript` / `resume-hint`) | **G** | `transcript` is (d): the worker would have to hand the launcher a filtered transcript dump on exit. `resume-hint` prints `npm run tui -- <origin>` plus the session. |
| `fullscreenScrollbar`, `fullscreenCopyOnSelect`, `fullscreenWheelScrollLines` | **G** | Copy-on-select is a **L:copy** grant per selection gesture (section 3.2). |
| `externalEditor` | **G**, launcher only | never sent to the worker |
| `images.autoResize`, `images.blockImages` | server | Attachment policy is the server's. Show read-only. |
| `defaultProvider/defaultModel`, `defaultThinkingLevel`, `modelThinkingLevels`, `thinkingBudgets`, `enabledModels` | server | p2 has `defaultModel`/`thinkingLevel` (`P2/src/runtime/settings.ts`); the others are **new** or (c) |
| `steeringMode`, `followUpMode`, `transport`, `httpIdleTimeoutMs`, `websocketConnectTimeoutMs`, `retry.*`, `compaction.*` (incl. `modelOverrides`), `cacheWarming`, `showCacheMissNotices` | server | p2 has a subset (`P2/src/runtime/settings.ts`). Read-only display. |
| `defaultTools`, `codemode.*`, `shellPath`, `shellCommandPrefix`, `npmCommand` | server / env | Tool loadout and shell are server or env configuration (`P2/plugins/envs`). Not TUI settings. |
| warning toggles, `enableInstallTelemetry`, `defaultProjectTrust`, `treeFilterMode`, `branchSummary.*`, `sessionDir`, `httpProxy` | (c) | No equivalent concept in p2. |

### 1.15 CLI behavior

pi flags: `CA/cli/args.ts:83-268`, `:300-348`. p2 has only `[url]` and `--owner-link` (`P2/src/hosts/tui-config.ts:92-100`).
The **new** `--join` flag comes from P0.

| pi flag | p2 | Where |
| --- | --- | --- |
| `--tui-mode` | unsupported (1.1) | — |
| `--verbose` | launcher: shows the expanded header and resource listing | launcher → worker flag |
| `--theme <name>` / `--use-theme`, `--no-themes` | launcher: overrides the **G** theme for this run; `--no-themes` skips custom theme files | launcher |
| initial message args, `@file` args | launcher: the text is posted to the worker as the first draft (not auto-sent). `@file` args are **L:attach** with consent. | launcher |
| `--continue/-c` | launcher remembers the last session per origin; the worker navigates to it | launcher config |
| `--resume/-r` | opens the session selector | worker |
| `--session <id>` | navigates; `--session-id` is an alias | worker |
| `--fork`, `--name` | (d) fork; `--name` renames the session after open (owner) | server |
| `--model`, `--provider`, `--thinking`, `--models` | owner: applied with `Chat.configure` to a new session or the opened one; guests: refused | server |
| `--session-dir`, `--no-session` | unsupported: sessions are server-side | — |
| tool allow/deny (`--tools`, `--no-tools`, `--exclude-tools`, `--no-builtin-tools`), `--system-prompt`, `--append-system-prompt` | unsupported: server configuration | — |
| `--extension`, `--no-extensions`, `--skill`, `--no-skills`, `--prompt-template`, `--no-prompt-templates`, `--no-context-files`, `--no-mcp` | unsupported. Local resource paths would be launcher-owned data; server resources are plugins. | — |
| `--approve`, `--no-approve` (trust) | unsupported | — |
| `--offline` | unsupported (the TUI is a network client) | — |
| `--api-key` | unsupported (credentials are the server's) | — |
| extension-defined flags | unsupported | — |
| `--print/-p`, `--mode json/rpc`, `--export`, `--list-models` | excluded from this guide | — |

### 1.16 Footer and `/session` data provenance

| Number | Scope | Source |
| --- | --- | --- |
| Session total tokens/cost | Whole session, including children and tools | `SessionMetrics.usage` (`P2/plugins/status/server.ts:107-125`; caveat already stated in `P2/src/web/CostPanel.tsx:25-26`). Label it "session". |
| Conversation tokens/cost | Viewed conversation | `view.docs["pi.usage"]` (`conversationUsage`, `P2/plugins/status/tui.ts`) or transcript `costs` |
| Cache hit rate | Latest committed response in the viewed conversation | `buildTranscript(...).latestAssistantUsage` → `cacheHitRate` (`P2/src/web/transcript.ts:110-112`) |
| Context tokens | Viewed conversation's active context estimate | `buildTranscript(...).contextTokens` |
| Context window (denominator) | Current model | Owner: `Models.models`. Guests cannot hold `Models` (`P2/plugins/models/server.ts:62-64`). Either add **new** guest-safe current-model metadata (`contextWindow`, `name`, `thinkingLevels` of the conversation's model only) to the `Chat` view state, or show tokens without a percentage. |
| Model and thinking | Viewed conversation | `pi.agent` |

`/session` shows the same distinctions.

### 1.17 Session selector adaptations

pi's selector depends on local full-text session data, which p2 does not have:

- Fuzzy tokens over id, name, all message text and cwd (`CMP/session-selector-search.ts:26-27`).
- Phrases and `re:` regex (`CMP/session-selector-search.ts:39-153`).
- Threaded sort.
- Tab toggles the scope between the current folder and all sessions (`CMP/session-selector.ts:170`, `:1032-1039`).

p2's `Search` is literal, returns bounded snippets and at most 41 hits (`P2/plugins/search/contract.ts:14-37`, `:64`, `:90-95`).
Session rows lack an explicit-name flag and branch ancestry (`P2/plugins/sessions/contract.ts:9-20`).

Adaptations:

- **Filtering.** Local fuzzy filtering over title, env:cwd and id. Message hits come from `Search.search`, shown in a
  separate "Messages" group labeled as literal matches. Phrases and `re:` are unsupported; the hint line says so.
- **Tab scope.** Tab keeps pi's meaning: current env:cwd versus all sessions.
- **Archived.** Archived scope is a separate key: `app.session.toggleArchived`, default Ctrl+A.
- **Sort.** Recent and relevance sorts are supported. Threaded sort groups by subagent parent
  (`Subagents`) rather than by forks.
- **Named filter.** pi's named filter becomes a "pinned" filter (`pinned` exists).
- **Delete.** Delete means archive, with restore available in the archived scope.

Adding regex/phrase search would be a `Search` contract change (d).

---

## 2. Where the port lives in p2

| Part | Files |
| --- | --- |
| Launcher (terminal, connection, sign-in, grants, consent UI, modes, output filter) | `P2/src/hosts/tui.ts`, `tui-client.ts`, `tui-config.ts`, `tui-grants.ts`, `tui-actions.ts`, `tui-trusted-ui.ts`, `tui-modes.ts`, `tui-filter.ts`, `tui-local-preferences.ts` |
| Bundle and sandbox | `P2/src/hosts/tui-bundle.ts`, `tui-sandbox.ts`, `tui-bootstrap.mjs`, `tui-worker-runtime.ts` |
| Runtime (screens, overlays, commands, renderer registries, context) | `P2/src/runtime/tui.ts`, `tui-commands.ts`, `tui-renderers.ts`, `tui-context.ts`, `tui-preferences.ts` |
| Copied components | `P2/src/tui/components/` (messages, transcript, tool card, status indicators and editor, selectors, header/footer/status lines), `P2/src/tui/tools/` (tool renderers), `P2/src/tui/theme/` |
| Runtime commands, keybindings, reload snapshot | `P2/src/tui/core-commands.ts`, `keybindings.ts`, `snapshot.ts` |
| Chat surface: transcript `ScrollView` over the dock, pending area, working indicator, sends | `P2/plugins/chat/tui.ts` (`ChatSurface`), `tui-commands.ts` |
| Plugin screens and cards | `P2/plugins/<name>/tui.ts` |

---

## 3. Isolation constraints and launcher grants

Constraints (`P2/README.md` "TUI isolation", `P2/DEV.md:32-54`, `P2/docs/p2-notes.md` "TUI"):

- The worker drops fs/net/child/worker/addon/wasi/inspector before evaluation
  (`P2/src/hosts/tui-bootstrap.mjs:13-16`). It runs with an empty env and V8 limits
  (`P2/src/hosts/tui-sandbox.ts:37-49`).
- All worker output passes `filterTerminalOutput` (`P2/src/hosts/tui-filter.ts:17`).
- The launcher accepts only `output`, `link`, `reload` and `exit` (`P2/src/hosts/tui-client.ts:158-167`).
- `P2/DEV.md:47-49` says any local file, clipboard or browser capability needs "an explicit, launcher-owned user grant
  with validated data, not a server-provided filename, URL or simulated prompt".

Every server and its downloaded code are untrusted relative to the visitor, owners included (`P2/docs/p2-notes.md`
threat model; `P2/README.md` TUI isolation). The rules below follow from that.

### 3.1 Grant kinds

A **grant** is the launcher's permission for exactly one action instance. It is bound to:

- the worker instance (sandbox identity),
- the server origin,
- the target session/conversation that the worker named at request time, and
- an expiry.

Grants are never inferred from unrelated input. A key press counts only for the action its binding names.

| Kind | How the grant arises | Actions |
| --- | --- | --- |
| **K: launcher-matched key** | The launcher resolves the guest's own keymap (section 4) on raw input before forwarding. A match for a privileged action id creates a grant for that action only. The key is consumed and not forwarded. | `app.clipboard.pasteImage`, `app.editor.external`, `app.suspend`, `app.message.copy`, `p2.attach` |
| **C: trusted confirmation** | The worker requests an action. The launcher shows its own consent UI (3.3) with launcher-known facts and the exact data. Only a local confirmation creates the grant. | `/copy` and other command-initiated copies, `openUrl`, `savePrefs`, `attach` of a dropped path, `download` |
| **N: no grant** | Sanitized, bounded, rate-limited output with no access to local data | `title`, `progress`, `programStatus` |

Rules:

1. **Privileged bindings are launcher-only.** The worker can never change the bindings of privileged action ids, or
   the external editor command. A `savePrefs` patch containing them is rejected before confirmation is shown.
   Otherwise, a confirmed-looking theme change could also remap Enter to `app.clipboard.pasteImage`.
2. **Unbound by default** if a privileged action would collide with a non-privileged default in the guest keymap
   (section 6.2).
3. **The worker may only suspend interception.** It can send `{kind:"keyContext", suspendPrivileged: true}` while a
   modal text input owns keys, e.g. transcript search, where Ctrl+G means "next match" (`TUI/keybindings.ts:196-199`).
   It can never request interception. A lying worker can only deny the user a privileged action, which falls under
   the owner-accepted denial of service.
4. **Copy by key (K)** asks the worker for the text: `request {kind:"copyText", grant}`, which returns the last
   assistant text or the selection, bounded to 1 MiB. The launcher writes it. It then shows a launcher-drawn one-line
   summary ("Copied 1 234 chars: <first line>") via the trusted UI. That summary does not take input, but it still
   suspends worker IO while drawn.
5. **Copy by command (C)**: `/copy`, the copy-URL action in the login dialog, and share-link copy show a preview of
   the full text (scrollable, with its length) and need explicit confirmation. Copy-on-select is a K grant from the
   selection gesture itself only if the launcher observes the mouse release; otherwise it is C.

### 3.2 Capability map

| Capability | Grant | Message / behavior | Notes |
| --- | --- | --- | --- |
| `capabilities` | — | Launcher → worker on `activate` and on change: `{kittyProtocol, modifyOtherKeys, colorDepth, platform, windowsKeys}` | Fixes the kitty bug; Windows defaults follow the guest platform |
| `preferences` | — | Launcher → worker: validated **G** data | Section 4 |
| `terminalColors` | — | Launcher → worker: colors and later scheme changes | The launcher queries the terminal itself |
| `copy` | K or C | 3.1 rules 4-5 | Native clipboard writer copied into the launcher (`CA/utils/clipboard.ts`); OSC 52 written by the launcher only |
| `paste` (right click) | K (mouse gesture observed by the launcher) | The launcher reads text and forwards it as bracketed paste | Text only |
| `pasteImage` | K | The launcher reads the image (`CA/utils/clipboard-image.ts`), then shows trusted confirmation with size and destination, then uploads (3.4), then posts `{kind:"attached", grant, uploadId, name, mime}` | The K grant alone does not upload: the image leaves the machine, so confirmation is required |
| `attach` | K (`p2.attach` opens the launcher file picker) or C (a dropped path) | Trusted picker/confirmation → bounded read (3.3) → upload → `attached` | The only path for local files |
| `externalEditor` | K | `request {kind:"editorText"}` → suspend worker IO → stop the terminal → spawn the **G** command with argv (no shell) on a temp file → restore → `editorResult` bound to the grant | Result dropped if the grant target changed |
| `suspend` | K | The launcher stops the terminal, resets modes (3.6) and raises SIGTSTP; on resume it redraws and posts `resumed` | |
| `title`, `progress`, `programStatus` | N | Sanitized (control characters removed), ≤ 80 chars / enum, ≤ 4 per second | Reset on exit |
| `openUrl` | C | Section 3.5 | |
| `download` | C | Section 3.5 | |
| `savePrefs` | C | `{patch}`. Confirmation shows the actual patch as a diff. Privileged keys and the editor command are rejected. The launcher writes `~/.pi/p2-tui/prefs.json` atomically. | pi's own files are never written |
| `image` | (d) N | Worker → launcher: a bounded PNG; the launcher decodes, re-encodes and emits graphics itself | |
| `terminal` | (d) | Section 3.7 | |

### 3.3 Trusted consent UI

The problem: the worker's terminal state (cursor, SGR, scroll region, synchronized output, alt screen) and its
asynchronous output can corrupt or spoof a launcher prompt. If the launcher paused output for one frame only, the
worker could paint over the prompt or read the user's keystrokes.

Protocol for every C grant, every K action that shows UI, the picker and summaries:

1. **Suspend worker IO for the whole interaction.** Stop forwarding input to the worker. Buffer worker output
   (bounded; on overflow, drop the frames and mark a full redraw). The worker keeps running.
2. **Reset drawing state.** End synchronized output, reset SGR, reset the scroll region, show the cursor, clear the
   screen. The prompt is then drawn on a known state.
3. **Show only launcher-known facts and explicit data.** Include:
   - the server origin from the launcher's fixed URL;
   - the action;
   - the file path, size and type (regular files only);
   - the destination session ID; the session title may be shown, labeled "server-reported";
   - the full URL, patch or text preview.

   Data from the worker is shown as data, never as instructions. Control characters are stripped.
4. **Consume confirmation keys locally.** Enter or `y` confirms; Escape or `n` cancels. Nothing reaches the worker.
5. **Redraw.** Discard the buffered worker output and send `{kind:"redraw"}`. The worker calls
   `tui.requestRender(true)`.
6. **Bind async results.** Every result message carries the grant id. If the worker was replaced (reload swap), or the
   worker reports navigation away from the grant's session/conversation, the launcher cancels the operation (abort
   the upload, delete temp files) and drops the result.
7. **Read local files safely.** Open with no-follow semantics, `fstat` the opened descriptor, and require a regular
   file. Reject devices, FIFOs, sockets and directories. Enforce the size limit before and during reading. Read only
   through that descriptor.

Uploading local data to the connected server is the user's explicit choice under this UI. The confirmation names the
origin because it is an exfiltration channel by design: the server receives what the user confirms.

### 3.4 Upload and launcher HTTP transport

All launcher HTTP follows the existing trusted request pattern (`P2/src/hosts/tui-client.ts:128-129`,
`P2/src/hosts/tui-config.ts:37-46` (claimOwner), `:67-71`):

- **Fixed URLs.** `new URL("/upload", origin)` with `URLSearchParams({session, name})`. No server-supplied path,
  query or origin. `session` must match the ID format the worker reported for the grant. `name` is the local basename,
  sanitized, at most 255 characters (checked server-side at `P2/plugins/files/server.ts:78-79`).
- **Headers.** `connectionHeaders(origin, credentials)` (`P2/src/hosts/tui-config.ts:34`) supplies the exact
  `Origin`, which `/upload` requires (`P2/plugins/files/server.ts:70-71`), and the cookie.
- **Redirects.** `redirect: "error"`, so credentials never follow a redirect.
- **Timeouts.** `AbortSignal` with a timeout (60 s for uploads, 10 s otherwise) and grant cancellation.
- **Size.** At most 25 MiB (`MAX_UPLOAD_BYTES`, `P2/plugins/files/uploads.ts:10`), enforced locally before sending.
  Streamed from the verified descriptor.
- **Response.** Read bounded (8 KiB), expecting `{id}`. Errors are shown in the launcher UI, not forwarded verbatim
  to the worker.
- **Cookie.** The cookie never appears in URLs, the worker, logs or child processes.

### 3.5 Opening URLs and downloads

Browser sign-in and TUI sign-in are separate. The launcher cookie is private to the launcher
(`P2/src/hosts/tui-config.ts:6-35`). Content endpoints authorize the browser independently:

- `/download` checks the principal from the browser's own cookie and refuses cross-site requests
  (`P2/plugins/files/server.ts:89-106`).
- Artifact URLs are authorized the same way.

Two distinct capabilities follow:

- **External URL** (`openUrl {kind:"external"}`), e.g. OAuth provider pages from `ProviderLogin.login.notices`.
  - `https:` only.
  - Shown in full in the trusted confirmation.
  - Opened with the OS opener via argv, with no shell and no credentials added.
- **Fixed-origin content** (artifacts, sent files, the web UI for a session).
  - **Open in browser.** `openUrl {kind:"origin", path}` with a path from a fixed allowlist (`/s/<id>`, artifact and
    download routes). The URL is built from the launcher's origin, so loopback `http:` is allowed when that is the
    configured origin. The confirmation says: "The browser needs its own sign-in (owner link or share link)."
    The cookie or a token is never put in the URL.
  - **Download** (`download {session, id}`, C grant): the launcher GETs `/download` with its own cookie. It uses the
    fixed route, `redirect: "error"` and a bounded size, and saves into a launcher-chosen folder (G pref, default
    `~/Downloads/p2/`) under a sanitized name, with no overwrite.
- **Hyperlinks** (OSC 8) stay stripped by the filter. A later filter rule may pass OSC 8 only for `https:` URLs whose
  visible text equals the URL. Raw OSC 8 is never allowed blindly.

### 3.6 Terminal modes owned by the launcher

`TuiAltScreen` writes these sequences (`TUI/tui-alt-screen.ts:63-75`, `:372-398`):

- autowrap off/on (`?7`);
- mouse modes 1000/1002/1006, optionally 1003;
- focus reporting (1004);
- synchronized output;
- OSC 133 markers.

- **Allowed modes.** The filter allows `?7` and, if the guest's mouse policy permits, `?1000`, `?1002`, `?1006`,
  `?1004`. `?1003` (all-motion) is allowed only with `fullscreenWheelScrollLines`/hover features enabled by the guest.
- **Tracking.** The launcher records every mode the filtered output enabled.
- **Cleanup.** On exit, suspend, worker crash, worker swap and launcher error, the launcher writes the inverse of every
  enabled mode plus a fixed reset: `?1000l ?1002l ?1003l ?1006l ?1004l ?7h ?2004l ?25h ?2026l`, SGR reset, scroll
  region reset, `?1049l`. A swap re-enters cleanly. Kitty keyboard state is the launcher's own
  (`ProcessTerminal.stop`).
- **OSC 133.** The markers stay internal. `TuiAltScreen` strips them from its screen lines (`TUI/tui-alt-screen.ts:411`,
  `:1690`), and the filter strips all OSC regardless.

### 3.6a As implemented (P0b)

- **Grants** (`P2/src/hosts/tui-grants.ts`). `Grants.create(action, "K" | "C", worker, target)` binds a random id to
  the sandbox instance, the launcher's origin, the target the worker last reported and a 10-minute expiry, with an
  `AbortSignal`. `valid(id, worker, action?)` checks all of that. A swap or crash cancels the worker's grants, a
  `{kind:"navigation", session, conversation}` report cancels grants for another target, close cancels everything.
  Results of a cancelled grant are dropped (`{ok:false, error:"cancelled"}`).
- **Actions** (`LauncherAction`): `K` actions name a privileged keybinding id and run with a context whose
  `ask(kind, payload)` asks the granting worker for data (`grantRequest`, answered from `runtime.launcherAnswers`);
  `C` actions validate the payload in `consent(payload)` (undefined denies without UI) and `run` only after
  confirmation. One interaction at a time; a request while busy is denied. Local error text stays in the launcher
  (a launcher notice); the worker learns only `failed`. P0b ships the framework; P5 registers the actions.
- **Worker API.** `ctx.grant(action, payload)` → `{kind:"request", id, action, payload}` → `{kind:"response", id,
  ok, value | error}`. The worker runtime reports `navigation` and `keyContext` after every input and render.
- **Privileged matching** (`PrivilegedKeys`). Built from the visitor's local keybindings only (pi files and p2
  prefs, never server defaults or the worker) and the guest platform, through `resolvePrivilegedKeys`; only ids with
  a registered K action are intercepted. A match is consumed before forwarding (key releases too, without firing).
- **keyContext** (rule 3). The worker sends `{kind:"keyContext", suspendPrivileged}` whenever pi-tui's focus is not
  the runtime itself (transcript search, a dialog's text input). The launcher stores only that boolean, resets it on
  swap and ignores everything else in the message.
- **Trusted UI** (`P2/src/hosts/tui-trusted-ui.ts`). `confirm(request)` and `notice(text)`. While active the client
  discards worker output (and title/progress messages) and gives every key to the UI. Drawing starts with
  `?2026l`, SGR reset, scroll-region reset, cursor shown and a clear, then an inverse bar "p2 launcher · on this
  computer · not the server's screen", `Server:` (the launcher's URL), `Action:`, facts (the target session is added
  by the launcher), and the data preview, scrollable, with control characters made visible (␛, ␇, …). Only Enter or
  `y` confirms; Escape, `n` and Ctrl+C cancel; other keys scroll or do nothing. On close it re-applies the worker's
  tracked modes and posts `{kind:"redraw"}`; the worker calls `tui.requestRender(true)`.
- **Modes** (`P2/src/hosts/tui-modes.ts`, `tui-filter.ts`). The filter admits `?7` (the autowrap fix) and the mouse
  modes pi's alt screen uses, by the visitor's launcher-only `prefs.json` key `mouse`: `"on"` (1000/1002/1006/1004,
  button motion), `"all"` (also 1003), `"off"`. The default is pi's: `"on"` inside tmux/screen/zellij, else `"all"`
  (`defaultMouse`, the same environment test pi-tui makes). `TerminalModes` records every private mode the worker set; `cleanup()` writes their inverses
  and the fixed reset of 3.6 (also `?1049l`) on exit, crash and before a swapped worker activates; `restore()` puts
  them back after launcher UI.
- **Mouse** (owner request after P5). The worker runs pi-tui's `TuiAltScreen` as is with the mouse captured unless the
  policy is `"off"` (`input.mouse` in the sandbox's start data): wheel scrolling, selection, scrollbar dragging and
  copy on select are pi-tui's code. pi's `fullscreenWheelScrollLines` (default `"auto"`) and `fullscreenCopyOnSelect`
  (default true) are applied from the visitor's settings. The only p2 part is pi-tui's clipboard write: its
  `copySelection` hook requests the `copy.selection` launcher action (instead of the OSC 52 the filter strips), and
  the launcher accepts it once, within two seconds after it saw, in the raw input, the left-button release ending a
  drag or a multi-click (`P2/src/hosts/tui-mouse.ts`, `SelectionGesture`). No consent screen: the launcher observed
  the gesture; pi-tui flashes "Copied!" or the failure from the answer. A request without that gesture is denied.
- **N actions.** `BridgeTerminal.setTitle/setProgress/setProgramStatus` post `title`, `progress` and `programStatus`.
  The launcher strips controls, bounds titles to 80 characters, applies at most four per second per kind (the latest
  throttled value follows), gates progress on `terminal.showTerminalProgress`, and on exit clears the title and
  progress and sends program status `clear`. The worker titles the window `π p2 · <host>` and reports progress and
  working/idle from the chat's `busy` context.
- **Tests:** `P2/test/p2/tui-grants.test.ts` (modes, trusted UI keys and visible data, grant binding, privileged
  matching, an isolation run with a scriptable fake worker: K only on its key and not while suspended, C denied by
  Escape/`n`, worker output and input suspended during consent, confirmation runs exactly once, navigation during
  consent cancels, unknown actions denied, title sanitizing and rate limit, mode cleanup on swap and crash; kitty
  decoding in the real worker both ways; search suspending Ctrl+G in the real worker). Suspend resets are tested with
  `app.suspend` in P5.

### 3.6b As implemented (P5): launcher actions

`P2/src/hosts/tui-actions.ts` (`launcherActions`), wired by `P2/src/hosts/tui.ts`. Workers call C actions with
`ctx.grant(name, payload)` and get `{ok: true, value}` or `{ok: false, error}` with `error` one of `denied` (invalid
payload, unknown action, or cancelled on the consent screen), `busy`, `cancelled` (the grant ended: navigation, swap)
or `failed` (the launcher shows its own error text; the worker never sees it). Session-bound payloads must name the
session the worker last reported (`navigation`).

| Name | Kind | Payload | Launcher behavior |
| --- | --- | --- | --- |
| `copy` | C | `{text, label?}`; text non-empty, ≤ 1 MiB; `label` is shown as "(server-reported)" | Shows the full text (scrollable) and its length; copies on confirmation, then a summary notice. `/copy` (chat) uses it with the last answer. |
| `copy.key` | K `app.message.copy` (Ctrl+X) | — | Asks the worker `copyText` → `{text}` (≤ 1 MiB; chat answers the last answer); copies and shows "Copied N characters: <first line>". |
| `openUrl` | C | `{kind: "external", url}` (https, no credentials, ≤ 2048) or `{kind: "origin", path}` | Origin paths: `/s/<uuid>`, `/artifact?session&name&version[&download]`, `/download?session&id`, built on the launcher's origin; content paths must be the bound session. The screen shows the full URL and, for origin paths, "the browser needs its own sign-in". Opens with the platform opener by argv, no shell, nothing appended. |
| `download` | C | `{kind: "file", session, id, name?}` or `{kind: "artifact", session, name, version}` | `GET /download` or `/artifact?download=1` on the fixed origin with the launcher's cookie, `redirect: "error"`, 60 s, ≤ 25 MiB (declared and streamed); saves into the download folder (launcher-only `prefs.json` `downloads`, default `~/Downloads/p2`) under a sanitized name with `O_EXCL` (`name (1).ext`, never overwrites); partial files are removed. The local path is shown in a notice, never returned (`{saved: true}`). |
| `editor.external` | K `app.editor.external` (Ctrl+G) | — | Asks `editorText` → `{text}` (null when there is no editable editor), writes a 0600 temp file, lends the terminal (worker IO suspended, modes undone, terminal stopped), runs the command by argv, restores, and sends `editorResult` `{text}` through the grant, so it is dropped after navigation or a swap. The command is launcher-only: `prefs.json` `externalEditor`, pi's `externalEditor`, `$VISUAL`, `$EDITOR`, then `nano`/`notepad`; split into argv without a shell (quotes group). |
| `suspend` | K `app.suspend` (Ctrl+Z) | — | Lends the terminal and raises SIGTSTP (keep-alive, SIGINT ignored while stopped); on SIGCONT restores modes and the worker redraws. Not on Windows. |
| `devCommand` | C, owner | `{action: "reload"}` (nothing else) | `POST /__p2_dev` with the launcher's sign-in and exact Origin; returns `{message}` from the server. The server decides whether it is a dev server. |
| `signOut` | C, owner | `{all: boolean}` | `POST /owner/logout` or `/owner/logout-all`. Denied for guests, and `all: false` on loopback (the device owner has no cookie). The server then revokes the connection, so the launcher shows "Signed out on this device." and the owner-link prompt (P0a), forgetting the cookie. |

Worker side: the chat surface answers `copyText`, `editorText` and `editorResult` (`registerLauncherAnswers`,
`P2/plugins/chat/tui-commands.ts`) and registers `/copy` (`p2.chat.copy`). `copy.selection` (kind `gesture`,
payload `{text}`) is pi-tui's copy on select (3.6a, Mouse); `copy.key` copies the last answer. **Deviations:**
`devCommand` is not restricted to loopback in the launcher (the server's route already requires the
owner and a dev server, and the consent screen confirms). Tests: `P2/test/p2/tui-actions.test.ts`.

### 3.7 Terminals (shell panels)

The worker cannot open the terminals byte channel (a separate authenticated upgrade, `Terminals.channel`,
`P2/plugins/terminals/contract.ts:17-46`). Raw output must never bypass the filter, the owner's included.

- **(d) Filtered terminal.**
  - The launcher opens the fixed-origin byte channel with the token the worker obtained from `Terminals.channel`.
    The route is fixed; the token is opaque and bounded.
  - The launcher relays the bytes to the worker as opaque frames, the same way it relays chord frames.
  - The worker runs a headless VT emulator and renders cells as ordinary filtered output.
  - Owner only, because `Terminals` is owner-only.
- **(d, optional) "Trust this server's terminal like SSH".**
  - A separate launcher mode, confirmed in the trusted UI and stored per origin in the launcher config, revocable.
  - Only in this mode does the launcher pass raw pty bytes. Even then it applies its exit cleanup.
  - Never enabled by a server-side owner variant or a worker request.

---

## 4. Guest admission and guest-local preferences

### 4.1 Guest admission (P0)

- **Redemption.** `--join <link>`, or a share link pasted at the prompt, where the prompt accepts either an owner link
  or `https://host/join/<token>` (`P2/plugins/sharing/server.ts:46`).
  - The launcher checks the link's origin against the URL argument (or takes the URL from the link when no URL is
    given).
  - It prompts for a display name. That name is unverified; the server stamps it on the guest.
  - It POSTs `/join` with `{token, name}` (`P2/plugins/sharing/server.ts:297-336`), using `connectionHeaders` (exact
    Origin is required, `P2/plugins/sharing/server.ts:304`), `redirect: "error"` and a 2 KiB body.
  - It stores the returned `Set-Cookie` value per origin, with role `guest` and the session ID.
- **Check on start.** Owner cookies use `/owner/check`. Guest cookies are checked by fetching `/__p2_tui`, which is
  admitted for guests, and then the `Access` object yields the grant. A 401/403 means the share was revoked or reset,
  or the session was archived: delete the stored cookie and prompt for a new link.
- **Revocation while running.** If `Access` becomes gone or forbidden, show a launcher-drawn notice ("Access to this
  session ended") and exit or prompt. No guest preferences or presence are sent before admission succeeds.
- **Loopback.** Direct loopback is always the device owner (`P2/src/hosts/tui-config.ts:60-62`), so guest admission
  applies to remote origins and proxied local origins.
- **Presence.** After admission the worker holds `GuestPresence` and shows "Guest · name · view/full" in the header.

**As implemented (P0a).**

- **CLI and prompt** (`P2/src/hosts/tui-config.ts`). `--join <link>` takes the origin from the link when no URL is
  given, otherwise the link must match it (`joinLinkToken`: `/join/<43-char token>`, no query/fragment/credentials).
  `--join` and `--owner-link` exclude each other. The sign-in prompt accepts an owner link or a share link; a share
  link asks for a name (one line, control characters stripped, at most 40 characters, asked again when empty).
- **Redemption** (`redeemJoin`): `POST /join` with `connectionHeaders` (exact `Origin`), `redirect: "error"`, a 10 s
  timeout and a 2 KiB response cap. The stored guest cookie of that origin is sent along, so rejoining keeps the
  identity (the server's rule). Server error text is reduced to one plain line. The invitation is never stored.
- **Storage.** `config.json` keeps a guest beside the owner cookie per origin: `{cookie?, guest?: {cookie, session}}`.
- **Start.** Remote origins: a valid owner cookie (`/owner/check`), else a valid guest cookie (`HEAD /__p2_tui`;
  401/403 forgets it and prompts again), else the prompt. Loopback is the device owner; a stored guest cookie never
  downgrades it. **Deviation:** an explicit `--join` on loopback joins as a guest for that run (useful for trying a
  guest view locally). Note that on loopback the server itself treats a cookie-less request as the device owner, so a
  revoked loopback guest silently becomes the owner on reconnect; revocation detection therefore applies to remote
  origins.
- **Revocation while running** (`P2/src/hosts/tui-client.ts`, `P2/src/hosts/tui.ts`). A WebSocket upgrade refused
  with 401/403, or a 401/403 from the bundle poll, is confirmed by the launcher's own `HEAD /__p2_tui` (the web page
  asks the same question with `HEAD /`). The client closes and, on the restored terminal, the launcher prints the web
  page's words by the cookie kind it stored, never the worker's role: a guest cookie gives "This share has ended." and
  "Paste a new share link to join again"; an owner cookie gives "Signed out on this device." and an owner-link prompt.
  It forgets only that cookie; a valid link for the same origin signs in again and starts a fresh client, Enter quits
  (`resumeAfterEnded`). The worker cannot trigger this beyond ending its own session.
- **Worker.** The header shows `guest · <name> (unverified) · view only|full access` from `Access`; the new
  `P2/plugins/sharing/tui.ts` holds `GuestPresence` from a slot surface (holding it during facet load would block the
  worker's startup, because the link activates only after `ready`), so the owner sees the TUI guest as connected.
- **Tests:** `P2/test/p2/tui-guest.test.ts` (argument rules, mixed prompt, restart reuse, ended shares re-prompt,
  rejoin identity, loopback owner, and an end-to-end guest through a Host/Origin-rewriting tunnel: header, presence,
  no cookie in the worker, revocation on link reset).

### 4.2 Preference split

Rule: preferences about how this person operates a terminal live with the person (the launcher). Preferences about
what the agent does live with the server or session.

| Preference | Owner of the data | Source |
| --- | --- | --- |
| Keybindings | Guest | `~/.pi/agent/keybindings.json` (migrated with a copy of `CA/core/keybindings.ts:201-261`), then `~/.pi/p2-tui/prefs.json` |
| Theme, custom themes, light/dark pair | Guest | pi `settings.json` `theme` + `~/.pi/agent/themes/*.json`, then p2 prefs |
| Display/editor keys from section 1.14 marked **G** | Guest | pi `settings.json` (nested keys as in 1.14), then p2 prefs |
| External editor | Guest, launcher only | `externalEditor`, `$VISUAL`, `$EDITOR`; never sent |
| Mouse policy, download folder | Guest, launcher only | p2 prefs |
| Model, thinking, agent behavior | Session / server | `Chat.configure`, `<data>/settings.json` |
| Credentials | Server | never leave the server |
| Last session per origin | Guest launcher | `~/.pi/p2-tui/config.json` |

Flow:

1. The launcher validates the files with copied schemas: `CA/core/key-id-schema.ts` and `THM/theme-schema.ts:52`.
   Input is size-capped (256 KiB) and only whitelisted keys pass.
2. It posts `{kind:"preferences", ...}` after admission and before `activate`, and again on file change (the launcher
   watches the files).
3. Writes go only through `savePrefs` (C grant, 3.2) into p2's own file. pi's files are only read.
4. Server `TuiPreferences` becomes optional server defaults. Precedence: built-in < server defaults < pi files <
   p2 prefs. Privileged-action bindings never come from the server.

Server code can read and relay whatever preferences reach the worker. Send only the whitelisted subset; never send
env, paths or commands.

### 4.3 As implemented (P1)

- **Launcher** (`P2/src/hosts/tui-local-preferences.ts`): reads `$PI_CODING_AGENT_DIR` or `~/.pi/agent`
  (`keybindings.json`, `settings.json`, `themes/*.json`) and `~/.pi/p2-tui/prefs.json` (`P2_TUI_CONFIG_DIR`) through
  bounded descriptor reads (regular files, 256 KiB each; at most 64 themes, 1 MiB in total). Keybindings pass the copied
  key-id pattern and legacy-name migration (`P2/src/tui/keybindings.ts`); settings pass the whitelist
  `TuiSettingsSchema` (`P2/src/runtime/tui-preferences.ts`, the **G** keys of 1.14, nested as pi spells them);
  themes pass the copied `validateThemeJson`. Built-in/system names are reserved, as in pi. The launcher watches the
  three directories (`fs.watch`, re-armed on change, 100 ms debounce) and re-posts only changed preferences.
- **`prefs.json`**: `{"keybindings": {...}, "theme": "light/dark", "settings": {...}}`, the same shapes as pi's files,
  overriding them. Launcher-only keys will join it in P5/P9 and are never posted.
- **Message**: `{kind:"preferences", preferences:{keybindings, theme?, settings, themes, problems}}`. `problems` are
  display-only diagnostics (labels like `settings.json: invalid terminal.imageWidthCells`), without paths or contents;
  `/hotkeys` lists them. The worker re-checks the shape (`parseLocalPreferences`).
- **CLI**: `--theme <setting>` (this run) and `--no-themes` (skip custom theme files), as pi.
- **Server defaults**: `<P2_DATA_DIR>/tui.json` is now `{"keybindings": {...}, "theme": "dark", "settings": {...}}`
  (`TuiPreferences` version 2). The old `{"theme": {"accent": 35}}` SGR object is ignored. Privileged ids are dropped
  on the server and again in the worker (`effectivePreferences`).
- **Terminal facts**: the launcher posts `{kind:"capabilities", trueColor, platform, windowsKeys, kittyProtocol}`
  (before `activate`, and again when kitty negotiation finishes) and `{kind:"terminalColors", terminal:{colors,
  scheme}}`. It queries OSC 10/11/4 + DA1 itself (100 ms timeout, late replies still apply), enables mode 2031
  light/dark reports, requeries on a report, consumes the replies (they are never forwarded) and disables 2031 on exit.
  COLORFGBG is evaluated by the launcher as the initial scheme. **Deviation:** this is the subset of P0b's
  `capabilities` that themes and platform key defaults need; P0b adds `modifyOtherKeys` and the rest.

---

## 5. Themes: from one global to per-instance

### 5.1 How coding-agent does it

- `theme` is a `Proxy` over `globalThis[Symbol.for(...)]` (`THM/theme.ts:648-664`), set by `initTheme`,
  `setTheme` and `setThemeInstance` (`THM/theme.ts:682`, `:698`, `:721`).
- Module state lives beside it:
  - `currentThemeName` (`THM/theme.ts:666`) and `registeredThemes` (`THM/theme.ts:670`);
  - one `onThemeChange` callback slot (`THM/theme.ts:730`);
  - terminal colors and scheme (`THM/theme.ts:133-157`).
- `Theme` itself reads module terminal state: `appearance` and `colors` (`THM/theme.ts:249-260`).
- `Theme`'s text attributes use Chalk (`THM/theme.ts:314-331`), whose color level is a process global.
- 46 files import the proxy. Among them: every message and tool component, `CMP/keybinding-hints.ts`,
  `CMP/diff.ts`, `REN/bash.ts:12`, `CMP/footer.ts`, and the derived theme factories (`THM/theme.ts:1022-1086`).
  These factories return closures that read the global.

Problems:

- **One theme per process.** Theme previews, two runtimes in tests, split views and server-side rendering cannot
  differ.
- **Hidden reads and baked strings.** Many components bake colors into strings at update time, not at render time.
  For example, `ToolExecutionComponent.updateDisplay` (`CMP/tool-execution.ts:270-276`) and its fallbacks
  (`CMP/tool-execution.ts:142-159`), plus the header. A swap needs explicit rebuilds, not just `invalidate()`.
- **Process coupling.** Global terminal colors and the file watcher tie a theme to one terminal and filesystem.

p2 runs one worker per viewer, so a global would be per-viewer today. Per-instance is still needed for previews, tests
and keeping module state out of hot-reloaded facets.

### 5.2 pi-tui assumptions

pi-tui components take explicit theme objects. Its other globals are per-terminal facts, acceptable per worker and
set from launcher messages:

- `getKeybindings()` (`TUI/keybindings.ts:315`), used by `Editor`, `Input`, `SelectList`, `SettingsList`,
  `CancellableLoader` and `TuiAltScreen`;
- `getCapabilities()` (`TUI/terminal-image.ts:167`) and `setCapabilityOverrides` (`TUI/terminal-image.ts:187`);
- the kitty flag (`TUI/keys.ts:25`, `:31`).

### 5.3 Design

- **Copy.** `P2/src/tui/theme/` holds:
  - `Theme` from `THM/theme.ts:185-373`, without fs, watchers, `globalThis` or registries;
  - `THM/theme-tokens.ts`, `THM/theme-schema.ts` and `THM/system-theme.ts`;
  - the two built-in JSON files.
- **Construction.** `new Theme({json, terminalColors, colorDepth})`. Terminal colors and appearance are per instance;
  `appearance`/`colors` read the instance fields, not module state.
- **No Chalk.** Bold, italic and similar attributes emit SGR directly at the instance's color depth.
- **`ThemeRef`.** Owned by `TuiRuntime`: `{current, version, subscribe}`.
  - Derived pi-tui themes (`markdown()`, `selectList()`, `editor()`, `settingsList()`) are created once per `ThemeRef`.
  - Each callback dereferences `ref.current` on every call: `heading: (t) => ref.current.fg("mdHeading", t)`.
  - So a swap never leaves stale derived objects.
- **Components.**
  - Every component gets `ctx` (`{theme: ThemeRef, keys, hints, ...}`).
  - Render-time colors use `ctx.theme.current`.
  - Components that bake strings implement `themeChanged()`, which rebuilds cached content (re-running `updateDisplay`
    for tool cards, the header text, bash output). The runtime calls it, then `tui.invalidate()` and
    `requestRender(true)`.
  - Caches of rendered lines are keyed by `ThemeRef.version`.
- **Adapting copies.**
  - The `theme` import becomes `ctx`.
  - `keyHint(...)` becomes `ctx.hints.key(...)`.
  - Tool renderers take `ctx` through the render context; remove their global imports.
  - `ThemedText` (`CMP/themed-text.ts:11`) takes `(theme) => string`.
- **Highlighting.** `ctx.theme.current.highlight(code, lang)` via lowlight. Scope classes map to `syntax*` tokens.
- **Preview.** The theme picker builds a second `ThemeRef` for its preview pane only.
- **Tests (P1 acceptance).**
  - Two runtimes in one process with different themes render different SGR.
  - Swapping a theme rebuilds an already rendered tool card.
  - The preview does not change the live transcript.
  - Terminal-color updates affect only the instance they were given to.

**As implemented (P1).** For P0c/P2 to build against:

```ts
// P2/src/tui/theme/theme.ts (copied tokens/schema/system theme beside it; built-ins in builtin-themes.ts)
class Theme {
	readonly name?: string; readonly mode: TerminalColorMode; readonly terminal: TerminalState;
	get appearance(): "dark" | "light"; get colors(): Readonly<Record<ThemeToken, Color>>;
	fg(token: ThemeColor, text): string; bg(token: ThemeBg, text): string; style(text, ThemeStyle): string;
	bold/italic/underline/inverse/strikethrough(text): string;     // plain SGR, no Chalk
	getFgAnsi/getBgAnsi; getThinkingBorderColor(level); getBashModeBorderColor();
	highlight(code, lang?): string[];                               // lowlight `common`, syntax* tokens, per line
	static language(hint): string | undefined;                      // fence info / file path → registered language
}
type TerminalState = { colors: TerminalColors; scheme?: "dark" | "light"; pending?: boolean };
createTheme(json, mode, terminal?): Theme; createSystemTheme(mode, terminal?): Theme;
resolveTheme({ setting, themes, mode, terminal }): { theme; error? }  // pairs, built-ins, custom data, system fallback

// P2/src/tui/theme/ref.ts
class ThemeRef { get current(): Theme; version: number; set(theme); subscribe(fn): () => void;
	readonly markdown: MarkdownTheme; selectList; editor; settingsList }  // created once, deref `current` per call
```

`TuiRuntime.appearance` (`P2/src/runtime/tui-appearance.ts`) merges server defaults and the launcher's preferences,
holds the terminal state and capabilities, and swaps `runtime.theme` (a `ThemeRef`) only when the selected theme, its
JSON, the terminal state or the color mode changed; it then invalidates and fully re-renders. The color mode is
`settings.terminal.trueColor ?? capabilities.trueColor`. The legacy global helpers (`P2/src/tui/theme.ts`) are gone
(P2): every surface reads its runtime's `theme`; `safeText`/`lineText` live in `P2/src/tui/render-context.ts`.

### 5.4 Contract between rendering (P0c/P2) and themes/commands (P0d/P1)

P2 and P1/P0d land in parallel. P1's `Theme` and `ThemeRef` (`P2/src/tui/theme/theme.ts`, `ref.ts`) arrived first, so
rendering consumes them directly; there is no interim fallback theme.

- **`TuiRuntime.theme: ThemeRef`.** Every surface and copied component reads colors through it (`ref.current.fg(...)`,
  `ref.markdown`, `ref.selectList`, `ref.editor`). P1 replaces the instance or calls `ref.set(theme)` on preference
  changes.
- **Baked strings.** Components that bake colored strings (tool cards, user/assistant messages, compaction, header,
  footer) remember `ref.version` and rebuild in `render()` when it changed, so a theme swap needs no per-component hook;
  the runtime only invalidates and re-renders.
- **`RenderContext`** (`P2/src/tui/render-context.ts`, P2) is the structural subset rendering needs:
  `{ theme: ThemeRef; keyText(id): string; requestRender(); cwd; ... }`. P0d's `TuiContext` is a superset;
  `keyText` is `ctx.hints.key`. Copied components take it instead of the global `theme`/`keyHint`.
- **Runtime split.** P0c/P2 own `TuiRuntime`'s identity (`session`, `conversation`, `identityKey`), drafts,
  submissions, scroll anchors, the layout root (header, body, dock, footer), status lines and the reload snapshot.
  P0d owns input dispatch (`handleInput`, commands, contexts, hints). Both edit `P2/src/runtime/tui.ts` with targeted
  edits only.
- **Surfaces and layout.** `TuiSurface.layout?(): { body, dock? }` gives the runtime a scrolling body (the chat's
  transcript `ScrollView`) and a docked part (pending area, editor). The runtime's root `VStack` is body, then dock
  (status lines, the surface dock, footer). Slots `header`/`footer` override the built-in header/footer; the status
  plugin registers `footer`. Transcript scrolling uses pi-tui's `tui.altScreen.*` keys (the `p2.pageUp/pageDown/bottom`
  overrides are gone).
- **Chat actions for commands.** P2 rewrites `P2/plugins/chat/tui.ts`; `ChatSurface` exposes `send(mode)`, `stop()`,
  `dequeue()`, `clear()` (Ctrl+C), `editor` and `contexts()` (`editorFocused`, `editorEmpty`, `busy`, `participant`)
  for P0d's command table, which registers the keys.

---

## 6. Keybindings and commands

### 6.1 coding-agent's wiring

- Static ids (`TUI/keybindings.ts:71`, `CA/core/keybindings.ts:25`) typed by interface merging
  (`CA/core/keybindings.ts:176`).
- Ad hoc wiring:
  - `CustomEditor.onAction` (`CMP/custom-editor.ts:84`) and the Esc/Ctrl+D special cases
    (`CMP/custom-editor.ts:101-125`);
  - `IM:3067-3135`;
  - per-selector `kb.matches`;
  - raw-key extension shortcuts (`IM:2281-2296`).
- No context model; conflicts are detected only among user overrides.
- `/hotkeys` is hand-written (`IM:6821`); slash commands are an if-chain (`IM:3199-3397`).

### 6.2 End-to-end precedence contract

Each input chunk passes these stages in order. The first stage that consumes it wins.

1. **Launcher (trusted).** Privileged action ids from the guest keymap (3.1), unless the worker has suspended
   interception for the current modal context. Launcher-drawn UI, when active, consumes everything (3.3).
2. **pi-tui global and alt-screen handling.** Debug, mouse, search when open, then viewport keys unless an overlay
   defers (`TUI/tui-alt-screen.ts:729-793`). p2 cannot reorder this. It configures it instead: transcript scroll and
   search ids are pi's `tui.altScreen.*` keys, and p2 commands must not claim them in contexts where the alt screen
   handles them. The dispatcher reports such claims as conflicts.
3. **Overlay stack.** The focused overlay's commands, then the overlay component.
4. **Commands by context.** Matched against the current context set; more `when` terms means more specific.
5. **Focused component** (usually the editor) with `tui.editor.*` / `tui.input.*`.

Collision handling:

- **Privileged vs anything.** At keymap build, the launcher checks each privileged key against all non-privileged
  bindings it knows: `tui.*`, `app.*` and the guest's p2 prefs. On a collision, the privileged action keeps the key
  only if pi has the same default. Example: pi's Ctrl+G is both `app.editor.external` and
  `tui.altScreen.searchNext`; pi resolves it by mode, and p2 by the worker's `suspendPrivileged` during search.
  Otherwise the privileged action loses the key and `/hotkeys` reports it.
- **Commands vs commands.** Same key and same context specificity: the user binding wins over defaults. Remaining ties
  resolve to the first registered command and are reported.
- **Plugin defaults never claim privileged keys**; the dispatcher drops such defaults.

### 6.3 Command registry

```ts
// P2/src/runtime/tui-commands.ts
export type TuiCommand = {
	title: string;
	category?: string;
	keys?: KeyId | KeyId[];   // defaults; pi defaults for pi ids
	when?: string;            // "chat && editorEmpty && !overlay"
	slash?: { name: string; argumentHint?: string; complete?(prefix: string, ctx: TuiContext): Awaitable<AutocompleteItem[] | null> };
	run(ctx: TuiContext, args?: string): void | Promise<void>;
};
export const TuiCommands = defineRegistry<TuiCommand>("p2.tui-commands", { conflict: "error" }); // key = command id
```

- **Ids.** pi ids where the semantics match (`app.model.select`), otherwise `<plugin>.<verb>`.
- **Contexts.** `chat`, `sessions`, `overlay:<id>`, `editorFocused`, `editorEmpty`, `busy`, `compacting`, `searching`,
  `owner`, `guest`, `participant`. `when` is a small boolean grammar.
- **Keymap rebuild.** pi-tui's `KeybindingsManager` has fixed definitions and only `setUserBindings`
  (`TUI/keybindings.ts:231-305`). When the `TuiCommands` table or prefs change, the runtime builds a **new** manager
  from `TUI_KEYBINDINGS`, the copied `app.*` table, plugin defaults and user bindings, then calls `setKeybindings(new)`
  (`TUI/keybindings.ts:311`). pi-tui components read `getKeybindings()` per input, so they pick it up.
- **Dynamic ids.** Plugin ids are not in the `Keybinding` union. All matching goes through
  `ctx.keys.matches(data, id: string)`, a helper that casts once internally.
- **Slash names.** Validated separately from command ids. The registry's `conflict: "error"` catches only duplicate
  ids. The runtime builds a slash-name index: a duplicate name disables the later command's slash form and is
  reported in `/hotkeys`. The command id stays usable.
- **Discoverability.**
  - Palette `p2.palette` (Ctrl+Shift+P and F1; unbound in pi).
  - `/hotkeys`, generated by category and context, showing conflicts, launcher-owned keys and config paths.
  - `/` autocomplete; hints via `ctx.hints.key(id)`, a copy of `CMP/keybinding-hints.ts:34-48`.
- **Compatibility.** pi `keybindings.json` (with legacy migration); unknown ids are kept and reported; guest-platform
  defaults.

This is better than coding-agent's approach because one registry drives keys, palette, slash commands and help, with
contexts, plugin contributions, defined precedence and visible conflicts. It also matches the root `AGENTS.md` rule
against hardcoded key checks.

### 6.4 As implemented (P0d)

- **Files.** `P2/src/runtime/tui-commands.ts` (`TuiCommand`, `TuiCommands`, the `when` parser, the dispatcher and the
  slash completion provider), `P2/src/runtime/tui-context.ts` (`TuiContext`, a superset of P2's `RenderContext`),
  `P2/src/tui/keybindings.ts` (pi's `app.*` table per guest platform, the `KEYBINDINGS` overrides, legacy migration,
  key-id validation, privileged resolution), `P2/src/tui/core-commands.ts` (palette, `/hotkeys`, exit, reload, view
  toggles).
- **`TuiCommand`** is the 6.3 shape plus `palette?: false` (hidden from the palette). `tuiFacet(name, factory,
  commands)` registers a slot and its commands. Ids from pi's table always use pi's defaults (`keys` is ignored);
  `tui.*` and launcher ids are rejected.
- **`TuiContext`** (`runtime.ctx`): `host, theme, keys {manager, matches, getKeys}, hints {keyText, keyDisplayText,
  key, raw}, keyText, requestRender, settings, role, identity, navigate, view {expandedTools, showThinking}, commands
  {run, runSlash, autocomplete, palette, hotkeys, list, contexts, report}, surface(name), notify, overlay(id,
  component, options), exit, reload`. `editor`, `status`, `working`, `dialog` and `grant` land with their phases.
- **Contexts.** The runtime contributes the screen name (`chat`, `sessions`, `models`; mutually exclusive),
  `owner`/`guest` (from `Access`), `connected`, `overlay` and `overlay:<id>`. The active screen adds its own through
  `TuiSurface.contexts()`; chat: `participant`, `editorFocused`, `editorEmpty`, `autocomplete`, `busy`.
- **Dispatch.** Commands are pre-sorted by specificity (term count), then user-bound, then registration order. The
  runtime dispatches before the screen (stage 4 before 5); `ctx.overlay` wraps the component so overlay-scoped
  commands run first (stage 3). While an overlay is focused only commands whose `when` names `overlay`/`overlay:<id>`
  positively are eligible; everything else goes to the overlay.
- **Reports** (`/hotkeys`): launcher keys lost to other bindings, plugin defaults dropped for privileged keys, command
  keys that pi-tui's transcript keys (`tui.altScreen.*` except the search-only ones) consume first, same-specificity
  overlaps (`canOverlap` checks satisfiability under the exclusive groups), invalid ids/`when`s, duplicate or invalid
  slash names, unknown user ids (kept, as pi does) and preference problems.
- **Ported actions.** `p2.stop` → `app.interrupt` (not while autocomplete shows, as pi's CustomEditor),
  `p2.followUp`/`p2.dequeue` → `app.message.*`, `p2.models` → `app.model.select` (`/model`), `p2.tools` →
  `app.tools.expand`, `p2.thinking` → `app.thinking.toggle`, `p2.exit` → `app.exit` (`!editorFocused ||
  editorEmpty`; `/quit`), `p2.reload` → `p2.tui.reload` (unbound, `/reload`), `p2.sessions` keeps Ctrl+R in `chat`
  (`/sessions`), `app.session.resume` (`/resume`) and `app.session.new` (`/new`) unbound like pi. New: `app.clear`,
  `p2.palette`, `p2.hotkeys`. The editor runs `/name args` through the slash index before sending; unknown slash text
  is sent as a message.
- **Deviations.**
  - The palette is **F1 only**: Ctrl+Shift+P is pi's `app.model.cycleBackward` default (non-Windows).
  - Core commands come from a runtime-owned facet (`tuiCoreFacet`, loaded by the worker runtime) rather than a
    plugin, like the header/footer fallbacks (7.1); they still go through `TuiCommands`, so they are rebindable,
    listed and conflict-checked.
  - Ctrl+N (old `p2.new`) is dropped: pi's `app.session.new` is unbound and Ctrl+N is its session-selector filter key.
  - `app.model.select` and `app.session.new` require `owner` (guests cannot hold `Models` or create sessions).

---

## 7. Plugin contribution model

### 7.1 Chord wiring

- **Registries are descriptors.** A registry is a descriptor only (`packages/chord/src/old/registry.ts:3-23`). Only objects of
  lifetime "host" may call `self.register` (`packages/chord/src/old/object.ts`). Duplicate keys across objects fail under
  `conflict: "error"` (`packages/chord/src/old/host.ts:606-636`).
- **Registration example:**

```ts
// P2/plugins/artifacts/tui.ts
const Facet = local("p2.tui-artifacts", { version: 1, input: obj({}, { open: true }) });
export default defineFacet((host) =>
	host.serve(Facet, (_input, _principal, self) => {
		self.register(TuiToolRenderers, { artifact: artifactRenderers });
		self.register(TuiCommands, { "artifacts.list": listCommand });
		return {};
	}, { lifetime: "host" }),
);
```

- **Subscription.** The runtime subscribes with `host.registry(R).subscribe` (`P2/src/runtime/tui.ts`). It disposes instances whose value identity changed and recreates them. A facet reload replaces values, so
  overlays and widgets from the old value are closed.
- **Fallbacks.** The built-in header and footer live in the runtime, not the registry. A plugin's `header`/`footer`
  entry overrides them, and two plugins doing so is a registry conflict.

### 7.2 Registries

| Registry | Key | Value | Web counterpart |
| --- | --- | --- | --- |
| `TuiSlots` | `screen:<name>`, `header`, `footer`, `widget-above:<plugin>`, `widget-below:<plugin>`, `composer:<plugin>` | `(ctx) => TuiSurface` | `Slots` (`P2/src/runtime/web.tsx:47`), `SlotList` prefixes (`P2/src/runtime/web.tsx:76`) |
| `TuiCommands` | command id | section 6.3 | toolbar buttons, sheets |
| `TuiToolRenderers` | tool name | pi `ToolRenderers` shape (`CA/core/extensions/types.ts:658`) with `ctx` | **new** web `ToolCards` replacing `P2/src/web/Chat.tsx:164` |
| `TuiToolRendererResolvers` | `<order>:<plugin>` | `ToolRendererResolver` with `next()` (`CA/core/extensions/types.ts:664-667`); run in key order, then `TuiToolRenderers`, then the generic card | — |
| `TuiEntryRenderers` | entry kind | `(item, ctx) => Component` | chat-mode web rendering |
| `TranscriptEntries` (existing, shared) | entry kind | pure `(data) => EntryDisplay` (`P2/plugins/chat/contract.ts:155`) | same registry. Chat-mode's pure function moves into a module imported by both `P2/plugins/chat-mode/web.tsx` and a new `P2/plugins/chat-mode/tui.ts`. |
| `TuiMarkdownTransformers` | `<order>:<plugin>` | `MarkdownTransformer` (`CA/core/extensions/types.ts:1519`), applied in key order | — |
| `TuiFooter` | `<plugin>` | `{order, render(ctx, width)}` | sidebar-foot style |
| `TuiOverlays` | overlay id | `(ctx, args) => Component & Focusable`, with `overlayOptions` | `openLayer` sheets |
| `TuiCompletions` | **provider id** | `{triggers: string[], priority, provider}` | composer popovers (section 8) |
| `TuiThemes` | theme name | theme JSON | `P2/src/web/theme.ts` |

Ordered registries use explicit numeric prefixes in their keys, because registry tables are maps. Several completion
providers may share a trigger character; they are consulted by priority.

`TuiContext` holds:

- `theme`, `keys`, `hints`;
- `scope` (`TuiScope`, `P2/src/runtime/tui.ts:43`);
- `identity` `{session, conversation}` and `navigate`;
- `editor`, `notify`, `status`, `working`, `dialog`, `overlay`;
- `grant(action, payload)`, the typed launcher bridge;
- `view` (expanded tools, show thinking).

---

## 8. `@` and Tab file completion (web and TUI)

### 8.1 How coding-agent does it

- **Tool provisioning.** `ensureTool` (`CA/utils/tools-manager.ts:349`) finds fd/rg in `~/.pi/agent/bin`
  (`CA/config.ts:639`) or on `PATH` (`CA/utils/tools-manager.ts:83-102`). Otherwise it downloads them (asset table
  `CA/utils/tools-manager.ts:29-68`, download `:258`). It skips the download when offline
  (`CA/utils/tools-manager.ts:361-364`) and on Termux (`:366-371`). Called at `IM:1088-1092`.
- **`@` completion** runs fd (`TUI/autocomplete.ts:149-240`) with `--type f --type d --follow --hidden` and excludes
  `.git`, honoring `.gitignore`. It returns at most 100 results, which are fuzzy ranked (`TUI/autocomplete.ts:772`).
- **Tab completion** reads the local filesystem (`TUI/autocomplete.ts:600-680`). It supports `~`, absolute and parent
  paths (`TUI/autocomplete.ts:549-588`).

### 8.2 Policy for p2

- **Where files live.** Files live where the session runs: the server or an SSH env (`P2/plugins/envs`).
- **Scope.** Completion is **cwd-relative only**, matching the workspace confinement: `workspacePath` rejects
  absolute, `~`, `..` and empty segments (`P2/plugins/workspace/protocol.ts:151-158`), and confinement is applied in
  `P2/plugins/workspace/environment.ts:56-98`.
- **Out-of-scope prefixes.** Typing `~/`, `/` or `../` yields no completion. The hint says "completion covers the
  session directory". `~` is never expanded with the launcher's home.
- **Later (d).** An owner-only broader mode may resolve `~` and absolute paths on the env (`hello.home`) with explicit
  access checks.
- **Access.** Participants only (`canSend`, as `Workspace`, `P2/plugins/workspace/worker.ts:164-165`).
  Private data directories are excluded. View-only guests get none.

### 8.3 `FileIndex` contract (P3)

```ts
FileIndex = remote("p2.file-index", { input: { session, conversation }, variants: { reader: {
  state: { changes: num() },                         // clients re-query when it advances
  methods: {
    complete: method({ query: string(≤200), limit?: ≤100, kind?: "any"|"file"|"dir" }, { items: {path, dir}[], truncated }),
    list: method({ path: string /* validated relative dir, "" = root */ }, { entries: {name, dir}[], truncated }),
  } } } });
```

Served in the session worker on `WorkspaceBackend`, sharing its env, confinement, private-path exclusion and watch
(its `changes` counter).

Index semantics:

| Aspect | Rule |
| --- | --- |
| Files | Tracked + untracked, not ignored (git); otherwise all |
| Directories | Derived from file paths' parent prefixes. Empty directories come from `list` (a single-level `openDirReader`) or the daemon op. |
| Hidden | Included (pi passes `--hidden`); `.git` excluded |
| Ignored | Excluded where `.gitignore` applies; `node_modules` excluded in walks |
| Symlinks | Listed, not followed (no loops, no escape). pi's `--follow` is a deliberate difference. |
| Bounds | 50 000 entries, 4 MiB of listing, 10 s per rebuild, `WALK_DIRECTORIES` 5000 (`P2/plugins/workspace/environment.ts:19-30`) |
| Truncation | `truncated: true` is surfaced; the client shows "partial index" |
| Ranking | Copy of `TUI/fuzzy.ts` with a basename bonus, then shorter paths, then lexical; `kind` filter applied |
| Cache | Per conversation, rebuilt lazily when `changes` advances (debounced); worker memory only |

Index sources, in order:

1. **MVP (P7).** `git ls-files -z --cached --others --exclude-standard` (existing,
   `P2/plugins/workspace/environment.ts:302-322`), then the bounded walk (`P2/plugins/workspace/environment.ts:323-355`).
   Extend both to return directories. There is no `fd`/`rg` probing via `exec`: `command -v` is not portable to
   Windows, `rg --files` returns no directories, and both are absent on most envs.
2. **Daemon op (P8, separate).** `listFiles {path, maxEntries, maxBytes, hidden, gitignore}` in the pi-env daemon,
   using the Rust `ignore` crate. Work items:
   - protocol doc and feature detection (`hello.version` / an `ops` list; old daemons fall back to the MVP);
   - client API in `ENV/src/remote-env.ts`;
   - an env-level capability on Durable's `ExecutionEnv` (an optional `listFiles` with a typed adapter, because
     `ExecutionEnv` lacks it);
   - a local implementation. `localDaemon()` returns only a binary path (`ENV/src/ssh.ts:362`), so local sessions need
     a `Connection` to it or a Node walker with the same semantics;
   - cancellation through the request context;
   - conformance tests against both envs.
3. **Optional tool install.** Only if wanted for the agent's own bash:
   - Normalize the daemon's Rust platform names (`ENV/docs/protocol.md:70-73`: `windows`, `x86_64`, `aarch64`) to the
     tools-manager's Node names (`win32`, `x64`, `arm64`; `CA/utils/tools-manager.ts:36-64`).
   - Download on the server, then upload through the daemon (`write` + `writeChunk`).
   - Extract (tar/zip) on the server side, set exec permissions, and install atomically (temp name + `rename`).
   - Verify the hash.

### 8.4 Editor integration

Shared pure module `P2/src/runtime/completion.ts`, imported by both UIs. It copies these pure parts of
`TUI/autocomplete.ts`:

- helpers `:8-145` (`parsePathPrefix`, `buildCompletionValue`, quoting);
- `:415-547` (`applyCompletion`, `extractAtPrefix`, `extractPathPrefix`);
- forced-Tab gating `:850-859`.

It excludes `:549-588` (homedir/statSync) and everything fs/spawn.

**TUI.** An `AutocompleteProvider` (`TUI/autocomplete.ts:271`):

- `@prefix` → `FileIndex.complete`;
- forced Tab on a path-like prefix → `FileIndex.list(dirname)`, filtered locally;
- `/` → commands.

Requests are debounced (~80 ms), aborted when superseded, and inserted as `@path` exactly like pi.

**Web** (`P2/plugins/chat/web.tsx:156-172`, plus the new-session composer):

- **Triggers.** `@` opens the popover after a token boundary. A forced **Tab** on a plain path-like token also opens
  it, using the same prefix extraction from the text before the cursor (`selectionStart`).
- **Precedence.** While the popover is open, Enter/Tab apply, arrows move and Escape closes. These win over send
  (Enter, `P2/plugins/chat/web.tsx:169-172`) and stop (Escape, `P2/plugins/chat/web.tsx:164-168`). Closed: unchanged.
- **IME.** Ignore keys while `event.nativeEvent.isComposing`; never open the popover mid-composition.
- **Chat mode.** `@pi` is the agent mention (`P2/plugins/chat-mode/contract.ts:49-51`). The provider never offers
  completions for a token that matches `MENTION`. While chat mode is on, file items are listed after a synthetic
  "@pi — mention Pi" item. The TUI follows the same rule.
- **Both composers.** The existing-session composer and the new-session composer. Before the session exists there is
  no `FileIndex`; the new-session composer offers completion only after creation, or via the env directory listing
  for the chosen cwd (`Envs.listDirectory`, owner).
- **Lifetime.** The same `FileIndex` reference is held while the composer is focused.

**Local files** never come from the worker; they come only via **L:attach** (3.2, 3.3).

---

## 9. Web UI features and their TUI exposure

| Web feature | Source | TUI exposure |
| --- | --- | --- |
| Shell, navigation, drawer | `P2/plugins/web-shell/web.tsx`, `P2/src/web/AppLayout.tsx`, `P2/src/web/navigation.ts` | Screens + overlays; Ctrl+R and `/resume` instead of a sidebar |
| Sessions grouped by env:cwd, pinned, busy, children | `P2/src/web/Drawer.tsx` | Session selector (1.9, 1.17) |
| New session (env + directory browser, model, first prompt) | `P2/src/web/new-session.tsx`, `P2/plugins/envs/DirectoryPicker.tsx` | `/new` overlay (`Envs.envs`, `Envs.listDirectory`) |
| Session options (rename, pin, archive/restore, relocate) | `P2/plugins/sessions/web.tsx` (Session sheet) | `/name`, `sessions.pin`, `sessions.archive`, `sessions.relocate` |
| Search, archived | `P2/plugins/search`, `P2/src/web/Drawer.tsx` | Session selector (1.17) |
| Transcript, tool cards | `P2/src/web/Chat.tsx`, `P2/src/web/Markdown.tsx`, `P2/src/web/Code.tsx` | 1.3, 1.4 |
| Composer (steer/follow-up, stop, queue edit, attachments, drag/drop) | `P2/plugins/chat/web.tsx:83-200`, `P2/src/web/composer-state.tsx` | Editor, pending area, attachments via **L:pasteImage/attach** shown as chips in a `composer:attachments` widget |
| Model/thinking sheet | `P2/src/web/ModelPicker.tsx` | 1.7 |
| Cost, context, cache, viewers | `P2/src/web/CostPanel.tsx`, `P2/src/web/SessionStats.tsx` | Footer and `/session` (1.16); viewers from `SessionMetrics.clients` |
| Owner notices, dev reload, worker retry | `P2/src/web/OwnerNotices.tsx`, `WorkerControl.retry` | Notification widget; `/retry-worker`; `/reload` (owner) |
| Logs | `P2/plugins/logs/web.tsx` | `/logs` overlay |
| Workspace (files, preview, changes/diff, commits, search, comments) | `P2/src/web/Workspace.tsx` | (d) `/files` via `FileIndex` + `Workspace.query({kind:"file"})`; `/changes` with the copied `renderDiff`; `/grep`. Comments skipped at first. |
| Workspace upload | `WorkspaceTransfer` | (d) **L:attach** with a target folder |
| Terminals | `P2/plugins/terminals` | (d) Filtered VT relay (3.7) |
| Sharing (links, reset, guests, block) | `P2/plugins/sharing/web.tsx` | `/share` (owner); copy via a C grant |
| Guest identity, read-only, presence | `P2/plugins/sharing/web.tsx`, `Access` | Header and presence after admission (4.1) |
| Chat mode, mentions, replies, notes | `P2/plugins/chat-mode/web.tsx:22`, `:65` | `composer:chat-mode` chip, `/chat-mode`, entry renderers, reply command (d) |
| Peer attribution | `P2/plugins/conversations/web.tsx` | User component prefix |
| Subagents | `P2/plugins/subagents/web.tsx` | `/agents`, header crumb |
| Artifacts | `P2/plugins/artifacts/web.tsx`, `P2/src/web/ArtifactPicker.tsx`, `P2/src/web/Viewer.tsx` | Card + `/artifacts`; text/Markdown inline; HTML/SVG via origin `openUrl` (browser sign-in, 3.5) or `download` |
| Sent files | `P2/plugins/send-file` | Card; text preview; `download` |
| Providers login | `P2/plugins/login/web.tsx` | `/login`, `/logout` (1.8) |
| Envs | `P2/plugins/envs/EnvsPanel.tsx` | `/envs` (owner): list, test, accept host key; config editing later |
| Ports | `P2/plugins/ports/PortsPanel.tsx` | `/ports` |
| Devices, sign out | `P2/plugins/devices/web.tsx` | `/devices` (owner) |
| Theme | `P2/src/web/theme.ts` | Guest-local theme |

---

## 10. Phased plan

Sizes: **S** ≤ 1 day, **M** 2–4 days, **L** 1–2 weeks. Every phase ends with `npm run check` and the TUI tests on
Node 26 (`P2/DEV.md`). Supporting server contracts always land before the UI that uses them. A command is registered
only in the phase that implements it.

Done: P0–P11 (see git history; the "As built" sections below describe them). P8, the daemon's `listFiles`, landed in
pi 55df12bf6 and p2 52eff3371. Of P12, `Chat.shell` with `!`/`!!`, fork and clone, templates and `/skill:` (10.8) and
the Mermaid transformer (10.7) are built. Open:

| # | Work package | Size | Acceptance criteria | Status |
| --- | --- | --- | --- | --- |
| **P12** | Later: launcher images, filtered terminal relay, optional trust-like-SSH mode, web `ToolCards` | L+ | Each behind its own design review | Open |

### 10.1 As built: P0c and P2

Where the implementation differs from the text above, and why:

- **Transcript model.** Components are keyed by the shared display items of `P2/src/web/transcript.ts`
  (`buildTranscript`), not by Durable entries. The items already join calls, live slots and results and
  cover p2's entry kinds (`p2.input`, chat entries, model-error notices, compaction failures). They keep their identity
  while unchanged, so an unchanged item keeps its component, a streaming answer becomes its committed entry under the
  same key, and only changed items rebuild (`P2/src/tui/components/transcript.ts`).
- **Reading position.** An anchor `{item key, entryId, line offset}`, not a line count from the bottom. While not
  following the end, the item at the top of the viewport stays on its row when output grows, older history is
  prepended or items above change height (Ctrl+O). Anchors are kept per (session, conversation) in the runtime and in
  the reload snapshot; a restored anchor in older history pages towards it.
- **Overlays and reload.** The snapshot carries identity, screen, toggles, per-identity drafts, pending send IDs and
  anchors (`P2/src/tui/snapshot.ts`, validated, migrating the version-1 format). The overlay stack is not carried:
  overlays close on reload, which P4's criterion allows ("restores it or closes it cleanly").
- **Sends while connecting.** Enter while the conversation reference is still connecting (after a reload or reconnect)
  is held and sent once the reference is live, with the same request ID; typing goes to the editor meanwhile. A read-only
  conversation refuses with a status line.
- **Ctrl+C** follows pi exactly: clear the editor, a second press within 500 ms exits. It does not abort; Escape does.
- **Status lines** sit in the dock above the editor (at most three, a repeated message collapses into a count,
  cleared on navigation and on send), not in the transcript as pi's `showStatus`/`showError`. Runtime notices are not
  conversation-scoped (they also occur on the sessions screen) and must not shift the transcript's reading position.
- **Header** is pi's logo with the server origin and role instead of the version, and only hints whose keys are bound.
  As in pi it is the first part of the transcript and scrolls away; other screens show it above the surface.
- **Footer** (status plugin, `footer` slot): conversation stats from `pi.usage`, cache hit of the latest response,
  context tokens against the owner's model catalog (guests: tokens without a denominator, and the owner-only catalog is
  never requested), the session total labeled `session $x` when it exceeds the conversation's cost. The git branch
  came later (10.7).
- **Tool renderers.** Shell: Durable reports the spill path as a diagnostic, not in `details`, so pi's truncation
  footer is not shown; the card's own elapsed clock is shown only for runs it watched. Edit: no local preview, the
  result's `details.diff`. Read: no pi-docs classification. Images: pi-tui's text fallback.
- **Code mode card** is pi's renderer (script preview, the newest eight calls with JSON arguments, output without
  Durable's `Script completed|failed / Wall time / Output:` header), extended with p2's live nested slots: depth
  indentation and a running call's newest output line. It replaces p2's earlier one-line summary format.
- **Plugin renderers.** `artifact`, `send_file`, `subagent` and (since P4) `ports` cards ship as `tui.ts` of their
  plugins. The ports card shows forward addresses only when they match Radius's pattern, as the web card.
- **Registries** (`P2/src/runtime/tui-renderers.ts`): `TuiEntryRenderers` values are `(entry, ctx) => Component |
  undefined` and replace the transcript's own display of that entry kind. The TUI also honors the shared
  `TranscriptEntries` registry when a TUI facet registers it.

### 10.2 As built: P3 (server contracts)

- **`Chat` version 3** (`P2/plugins/chat/contract.ts`; versions 1 and 2 bind through `accepts`):
  - `model` state for viewers and participants: the conversation's model from the server catalog
    (`provider, modelId, name, contextWindow, reasoning, thinkingLevels`), or null. It is the guest-safe footer
    denominator of section 1.16; guests still never hold `Models`.
  - `compact({instructions?})` returns the Durable compaction task; `abortCompaction()` aborts this conversation's live
    compaction tasks (those in `pi.live.compactions`) and returns how many were marked. Participants, so a full guest
    may compact or stop a compaction, as they may send or stop. One-shot agent conversations refuse `compact`.
  - `reset({handoff?})` is **owner only**: a new context changes what the agent knows for everyone in the session.
  - `dequeueOwn()` withdraws the caller's queued inputs, chosen by the server-stamped author of each input's entry, in
    submission order, and returns `{restored, skipped}`; inputs placed or withdrawn meanwhile count as skipped. Other
    authors' inputs stay queued (they are not moved to drafts, unlike `stop`).
- **`enabledModels`** is a p2 settings.json key (`P2/src/runtime/settings.ts`) with pi's pattern format: exact
  `provider/modelId` or `modelId`, `*`/`?` globs over either, optional `:level`. `Models` version 2 exposes the raw
  patterns, the resolved `scopedModels` (`P2/plugins/models/scope.ts`) and `setEnabledModels` (owner).
- **`FileIndex`** is its own plugin (`P2/plugins/file-index`) rather than code inside the workspace plugin, which
  another work stream owns. It consumes `WorkspaceBackend` unchanged: `query({kind:"files"})` (git ls-files or the
  bounded walk, with their bounds and private-path exclusion) for the index, directories derived from file paths,
  `query({kind:"list"})` for `list`. The index is cached per conversation (`FileIndexCache`, a worker local) and rebuilt
  lazily when `changes` advanced, at most once per second. Ranking (`rank.ts`) is pi's `scoreEntry` (name exact 100,
  name prefix 80, name substring 50, path substring 30, directories +10), then depth, length and name; p2 adds fuzzy
  matches (pi-tui `fuzzyMatch`) below every substring match, since there is no fd query. `/`, `~` and `..` prefixes
  complete nothing.

### 10.3 As built: P4 (TUI on the contracts)

- **Selectors are overlays** (`ctx.overlay`, bottom-anchored, full width), not components swapped into the editor's
  place as in pi. Overlays already close on navigation, reload and plugin replacement, which gives P4's "reload during
  an overlay closes it cleanly"; the model screen is gone (a version-1 snapshot on it returns to chat or sessions).
- **Models** (`P2/plugins/models/tui.ts`): pi's model selector (`P2/src/tui/components/selectors.ts`) with Tab
  all/scoped, current and default badges and Ctrl+S (`app.models.save`) to set the default; pi's thinking selector
  (`/thinking`, Ctrl+S `app.thinking.save`); `/model provider/id` switches at once; Shift+Tab cycles the model's
  levels (from `Chat.model`); Ctrl+P / Shift+Ctrl+P cycle the scope with its `:level`, else every signed-in model.
  `/scoped-models` is a reduced copy of pi's selector: toggles, Ctrl+S saves exact `provider/modelId` patterns. Without
  a session a choice sets the default for new sessions. Guests (and owners before the catalog arrives) get a read-only
  status line. The catalog is not refreshed from the selector (the server keeps it; login is P6).
- **Sessions** (`P2/plugins/sessions/tui.ts`): the sessions screen is pi's selector with the 1.17 adaptations.
  Threaded sort nests a session's named subagent conversations (`Subagents`); selecting one opens that (session,
  conversation). Message hits (`Search`, owner, debounced) form a separate "Messages (literal matches)" group. Keys:
  Tab scope, `app.session.toggleSort`, `app.session.toggleNamedFilter` (pinned), `app.session.toggleArchived`
  (Ctrl+A), `app.session.delete` (archive with confirmation; restore in the archived scope), `app.session.rename`,
  `app.session.togglePath` (session IDs), `p2.session.pin` (Alt+P). They are registered commands whose `when` has four
  terms (`sessions && selector && !overlay && !creating`), so Ctrl+D archives here instead of `app.exit`.
- **`/new [cwd]`** creates a session in the viewed session's env:cwd (or the given directory) and opens it, as pi's
  `/new` starts over in place; without a session the `+ New session` prompt asks for a directory. **`/name <title>`**
  renames (owner). **`/session`** (status plugin) lists the footer's numbers with their scopes (section 1.16).
- **Chat**: `/compact [instructions]`, Escape aborts a running compaction (and stops a busy run; the compaction
  indicator says so), `/new-context [handoff]` (owner), Alt+Up is `dequeueOwn` (the caller's queued texts, then the
  editor's text; skipped ones are reported). Chat's commands now include `!overlay`, so Escape in a selector never
  stops the agent.
- **Footer**: guests get the context percentage from `Chat.model`.

### 10.4 As built: P7a-P7c (file completion)

- **P7a** is the P3 `FileIndex` plus tests on bounds: a directory beyond the walk's 5000 directories reports
  `truncated` and still ranks within `limit` (at most 100). It does not extend the workspace plugin's git/walk to list
  directories: directories derive from file paths, and empty directories appear only in `list` (Tab).
- **P7b** (`P2/src/tui/completion.ts`): `FileCompletionProvider` wraps the command registry's slash completion; `@`
  asks `FileIndex.complete` (the editor debounces `@`; superseded requests are aborted through the editor's signal),
  forced Tab lists the token's directory (`FileIndex.list`) and filters by name prefix, directories first (pi-tui's
  `getFileSuggestions`), a single Tab match applies at once. Out-of-scope prefixes and a partial index show a status
  line. The text handling (`P2/src/runtime/completion.ts`) is a copy of pi-tui's pure helpers, shared with the web.
- **P7c** (`P2/src/web/file-completion.tsx`): the session composer only; the new-session composer offers none (no
  session yet; the env directory listing alternative of 8.4 is not used). The FileIndex hold starts on focus and ends
  30 s after blur. Enter and Tab apply, arrows move, Escape closes ahead of send and stop; Tab without a path-like
  token keeps moving focus. IME: keys during composition are ignored and composition closes the list. `@pi` as a whole
  token never completes (`MENTION_TOKEN`); the synthetic "@pi — mention Pi" item comes first while chat mode allows
  replies (`canReply`, which chat-mode sets only in chat mode). Documented as a p2 addition in
  `P2/docs/p2-notes.md` (Decisions).

### 10.4c As built: P10 (settings, theme picker, rebinding)

- **`savePrefs`** (C, `P2/src/hosts/tui-prefs-save.ts`): payload `{patch: {keybindings?, theme?, settings?}}`, `null`
  removes a key, nested `settings.terminal`/`settings.markdown` merge one level. Refused before any screen
  (`validatePrefsPatch`): privileged ids in `keybindings` (3.1 rule 1), any other top-level key (the editor command,
  `mouse`, `downloads`), settings outside `TuiSettingsSchema` or with invalid values, invalid key ids or theme
  settings, and patches that change nothing. The screen shows the file path and a leaf diff of `prefs.json`
  (`- path: old` / `+ path: new`, `prefsDiff`). The run re-reads the file, applies the patch (unknown and launcher-only
  keys survive untouched) and writes atomically (a fresh 0600 temp file renamed over `prefs.json`). The launcher's
  watcher then posts the new preferences; a missing `~/.pi/p2-tui` is watched through its parent so a first save
  applies too. pi's files are never written.
- **`/settings`** (`P2/src/tui/settings.ts`, core command `p2.settings`): pi's `SettingsList` with the **G** keys of
  1.14 (pi's labels, values and defaults) and the theme. Changes are collected and proposed as one patch when the
  overlay closes. **Deviation:** no read-only server-settings section yet (no owner contract exposes
  `<data>/settings.json`); the footer points to `/model` and `/session`.
- **Theme picker** (`ThemePicker`): `system`, the built-ins, custom themes from the launcher, and `automatic` (a light
  and a dark theme, pi's pair setting). The preview pane renders sample Markdown, code, diff colors and a user message
  with its own `ThemeRef` (`ctx.prefs.previewTheme`); the live theme changes only after the save.
- **`/keybindings`** (core command `p2.keybindings`): every command plus pi-tui's editor/transcript ids with their keys;
  Enter captures the next key (`parseKey`), Backspace unbinds (`[]`), Delete restores the default (`null`), Esc cancels;
  each capture is one `savePrefs`. Launcher-owned ids are listed as such and not editable.
- **Context:** `TuiContext.prefs` (`themeSetting`, `themeNames()`, `previewTheme(setting)`, `keybindings`,
  `save(patch)`).
- **Tests:** `P2/test/p2/tui-settings.test.ts` (patch validation incl. privileged ids and the editor command, diff,
  atomic write keeping other keys, `/settings` one patch with an isolated preview, `/keybindings` capture and the
  launcher-owned refusal, end to end: diff screen, file write, watcher, the worker repainting in the new theme).

### 10.4b As built: P9 (attachments)

Launcher actions (`P2/src/hosts/tui-actions.ts`, section 3.6b's table gains):

| Name | Kind | Payload / trigger | Behavior |
| --- | --- | --- | --- |
| `attach` | C | `{path?}` (`/attach [path]`; a dropped path pasted after `/attach`) | With a path: a first screen names it (the launcher resolves quotes, `file://`, backslash escapes, `~/`, relative to its own cwd). Without: the launcher's file picker (`TrustedUi.pick`: this computer's directories, filter by typing, Backspace up, Esc cancels; the worker sees nothing). Then the facts screen (path, size, type, session) and, after Enter/`y`, the upload. Result `{id, name, size, mimeType?}`, never the path. |
| `attach.key` | K `p2.attach` (unbound) | — | Picker, facts, upload; the chip arrives through `attached`. |
| `paste.key` | K `app.clipboard.pasteImage` (Ctrl+V) | — | pi's order: copied files (macOS) → facts and upload each; an image (wl-paste, xclip, native; png/jpeg/webp/gif) → a confirmation with type, size, generated name and session, then upload; else the clipboard text is pasted into the worker as a bracketed paste (controls except newline and tab removed). |

- **Reading local files** (`openLocalFile`, section 3.3 step 7): `open` with `O_NOFOLLOW | O_NONBLOCK`, `fstat` of the
  descriptor, regular files only (directories, FIFOs, sockets, devices and final symlinks are refused), the 25 MiB limit
  checked first and again while streaming from that descriptor, which stays open from the facts screen to the end.
- **Upload** (section 3.4): `POST /upload?session&name` on the fixed origin with `connectionHeaders` (exact Origin and
  the launcher's cookie), `redirect: "error"`, 60 s and the grant's signal (navigation and swaps cancel), a streamed
  body counted against 25 MiB, an 8 KiB answer that must carry a UUID `id`. The session is the grant's target, never
  a worker-supplied one. Errors stay in the launcher; the worker gets `failed`.
- **Worker** (`P2/plugins/chat/tui.ts`, `tui-commands.ts`): pending uploads per identity show as chips
  (`[name size]`) in the composer line; the next send passes their ids (`Chat.send({attachments})`, text may be
  empty) and clears them; Backspace on an empty editor removes the last (`p2.chat.detach`), `/detach` all;
  `/attach [path]`. Pending uploads are not part of the reload snapshot (a reload drops the chips; the uploads stay on
  the server unused). **Deviation:** a dropped file needs `/attach` typed before the drop (the terminal pastes the
  path; the editor does not guess whether pasted text is a local path).
- **Tests:** `P2/test/p2/tui-attach.test.ts`.

### 10.4a As built: P6 (login/logout)

`P2/plugins/login/tui.ts` (owner; `when: owner`). `/login [provider]` lists `ProviderLogin.providers` (pi's provider
selector), then the login method when there are several, then `LoginDialog`, a copy of pi's `LoginDialogComponent`
driven by the server's `LoginState` instead of callbacks. `/logout [provider]` lists providers with stored credentials.
Both complete provider ids. One `ProviderLogin` hold spans the flow (the server cancels an unfinished login when the
hold ends); the dialog's `dispose` (any overlay close: its own, navigation, reload, plugin replacement) cancels a
running login, waits for it to settle and dismisses it.

- **Notices.** `auth_url` and `device_code` show the address as text (and the code); `progress`/`info` as pi.
  Server text is sanitized (`lineText`). Nothing is opened automatically (pi's `openBrowser` is gone): Enter (while
  no prompt waits) or `app.tools.expand` (while one does) asks the launcher for `openUrl` `{kind:"external"}` (https
  only, shown in full in the launcher's screen); `app.message.copy` asks for `copy` with the address (pi's key; the
  launcher suspends its own Ctrl+X while the dialog has focus, rule 3).
- **Prompts.** `text` and `manual_code` use an `Input` (manual code with the web's help text, so pasting the
  redirect URL works remotely); `select` a `SelectList`. `secret` uses `SecretInput`
  (`P2/src/tui/components/secret-input.ts`): dots while typing, bracketed paste kept whole, no history, value wiped on
  submit, never echoed (pi's `> value` line is gone), not part of the reload snapshot, and an answer error has the
  value masked before it becomes a status line.
- **Cancel and dismiss.** Escape cancels a running login; once finished, Enter or Escape closes and dismisses it.
- **Infrastructure:** `ctx.overlay` now calls an optional `dispose()` of the component when its overlay closes for any
  reason (`P2/src/runtime/tui.ts`, `tui-context.ts`).
- **Tests:** `P2/test/p2/tui-login.test.ts` (a remote owner on the real login server with a fixture provider: secret
  never rendered, snapshotted or in status lines; OAuth with the launcher's `openUrl`/`copy` and the pasted code;
  cancel, dismiss, closing ends a running login; `/logout` with nothing stored).

### 10.5 As built: P11a-P11i (web-parity panels)

Tests: `P2/test/p2/tui-p11.test.ts`. Panels are overlays on two generic components in
`P2/src/tui/components/list-overlay.ts`: `ListOverlay` (filter, `→` cursor, per-row actions keyed by a binding id
or a fixed panel key, footer, `follow` for log tails) and `ConfirmOverlay`/`confirm(ctx, lines)` (y/Enter, n/Escape);
`TextViewer` shows a file or diff. Each feature lives in its plugin's own `tui.ts` (the plugin that owns the
contract), so no plugin gains a dependency.

- **P11h** (`P2/plugins/subagents/tui.ts`): `/agents` lists the main conversation, subagents and one-shot agents;
  Enter navigates to (session, conversation), keeping each conversation's draft (P0c identities); Ctrl+A shows
  archived ones, Ctrl+D archives/restores (participants; one-shot agents are read-only). `/main` returns. The footer
  crumb is `cwd • title › <subagent>`. `TuiContext.navigate(screen, session?, conversation?)` takes the
  conversation.
- **P11b** (`P2/plugins/chat-mode/tui.ts`): the reply quote and mention note come from
  `P2/plugins/chat-mode/display.ts`, shared with the web facet. The `composer:chat-mode` chip (rendered by the chat
  surface from `runtime.slots("composer:")`, one line under the editor) shows `Chat · <waiting>` and the hint while
  on, and `[Chat off · /chat-mode]` to the owner only. `/chat-mode` toggles (owner). `/reply` picks the message the
  next send answers (the web's hover button / long press); the pending area shows "↪ Replying to …", and `/reply`
  again cancels. Replies and the first `@pi` item exist only while chat mode is on (the web's `canReply`).
- **P11d** (`P2/plugins/logs/tui.ts`, `P2/plugins/status/tui.ts`): owner notices are status lines (pending ones
  summarized once, then one line per new notice); `/notices` lists them and Ctrl+D dismisses. `/logs [source]` opens
  the viewed session's worker log (else the server's), follows the tail and Tab cycles sources. A failed session
  worker (`SessionStatus.error`) is reported once with `/retry-worker` (`WorkerControl.retry`). **Deviation:** dev
  reload is `/dev-reload`, not `/reload` (that is the TUI's own reload, P0c). The dev channel `/__p2_dev` is an owner
  HTTP route, so the command asks the launcher for a C action `devCommand` (`{action: "reload"}`). The launcher action
  exists since P5 (3.6b).
- **P11e** (`P2/plugins/envs/tui.ts`): `/envs` is the one environment screen. Enter moves the viewed session to the
  selected environment (section 10.6). Management is on secondary keys:
  - Ctrl+T tests and the list shows the last test.
  - Ctrl+K reviews an unverified or changed host key in a confirmation with the fingerprints and sends exactly the
    test's `lines`.
  - Ctrl+F forgets a key (also confirmed).
  - Config editing, key generation and upload stay on the web.
- **P11f** (`P2/plugins/ports/tui.ts`): `/ports` lists forwards with Radius addresses only (the card's `FORWARD`
  pattern; other server-reported URLs are not shown). Ctrl+P makes one public after a confirmation (private at once),
  Ctrl+D closes, `/ports open <port> [name] [public]` adds (public confirmed first). Opening an address can use P5's `openUrl`
  (`{kind: "external", url}`).
- **P11g** (`P2/plugins/devices/tui.ts`): mint a one-time token (only when `canMint`, with the web's warning). Signing
  out is a C launcher action `signOut` (`{all}`): the cookie lives in the launcher, and its consent UI is the
  confirmation. The launcher action exists since P5 (3.6b): it calls the sign-out route with its cookie; the refused reconnect then
  forgets the cookie and asks for an owner link.
- **P11i** (`P2/plugins/workspace/tui.ts`, a new file in impl-p2b's plugin; nothing of theirs changed): `/files
  [dir]` browses (`Workspace.query list`) and shows files (`file`), `/changes` lists `status` and shows a change's
  diff, `/grep <text>` searches and opens the match at its line. All go through `Workspace` (the guide said
  `FileIndex` for `/files`; the workspace listing carries sizes and ignored flags and is one reference for the three).
  Participants only (`when: participant`), so view-only guests never acquire `Workspace`. Git's unified patch is
  converted to pi's numbered diff lines (`piDiff`) for the copied `renderDiff`. Worker text is sanitized line by line
  (`lineText`). Comments, commits and uploads stay on the web.
- **Owner panels** (`/logs`, `/notices`, `/retry-worker`, `/dev-reload`, `/envs`, `/ports`, `/devices`, `/share`)
  are `when: owner`; the notice and worker-status watches start only for owners. A test asserts that guests acquire
  none of them.
- **P11a** (`P2/plugins/sharing/tui.ts`): `/share` (owner) is the web's share sheet: the read-only and read/write
  links and the guests connected now (live from `Sharing.guests`, which is the presence UI on the owner's side).
  Enter copies a link through the launcher's `copy` (`{text, label}`; created first when missing), and a first
  read/write link on a remote environment is confirmed in the worker before it exists (the web's "Guests can run
  commands on …"). Ctrl+R resets a link and Ctrl+D removes a guest; both are confirmed. The TUI never shows a link
  itself: only the launcher's consent screen does, on the owner's terminal. On the guest's side, the header (P0a)
  shows name, "(unverified)" and access. A view-only guest gets "Joined as <name> (unverified) · read-only" where the
  editor would be (the web's read-only bar). GuestPresence is still held from the `widget-above:sharing` slot.
- **P11c**:
  - **Artifacts** (`P2/plugins/artifacts/tui.ts`). The card adds "/artifacts opens". For text and Markdown it shows
    the content the call wrote: 8 lines, all when expanded. A call with `inline: true` shows all of it at once,
    Markdown rendered; inline HTML and SVG keep the card line.
  - **`/artifacts`** lists `ArtifactList`. Enter shows an artifact inline: Markdown rendered with the instance
    theme, text and HTML/SVG source as sanitized lines. HTML/SVG carry a "Source only" note, because they run only in
    a browser. Ctrl+B is `openUrl` `{kind: "origin", path: "/artifact?…"}` and Ctrl+S is `download`
    `{kind: "artifact", …}`; the panel and the launcher's consent screen both say the browser needs its own sign-in.
  - **Sent files** (`P2/plugins/send-file/tui.ts`). The card adds "/downloads saves".
  - **`/downloads`** lists the `send_file` results of the loaded transcript (`ChatSurface.toolViews`, the web card's
    checks: a UUID snapshot ID, a name, a size). Enter previews text, Ctrl+S is `download` `{kind: "file", …}` and
    Ctrl+B is `openUrl` on `/download?…`.
  - **Deviation: two new worker contracts.** The TUI worker has no cookie, so it cannot read `/artifact` or
    `/download` for inline views. Both contracts are new objects, so no existing contract changed:
    - `ArtifactContent.read({name, version})` (`P2/plugins/artifacts/contract.ts`): at most 512 KiB of text,
      `truncated` otherwise.
    - `SentFiles.preview({id})` (`P2/plugins/send-file/contract.ts`): the first 256 KiB as text, or `null` for
      binary (NUL or invalid UTF-8).
    - Both are served by the session worker from the data directory, with the routes' authority (`canView` on the
      session). Tests are in `P2/test/p2/artifacts.test.ts` and `P2/test/p2/send-file.test.ts`.
  - Bounding and never overwriting downloads are the launcher's job (3.6b).
- **Launcher results** (`P2/src/tui/grant-notice.ts`): `ok` shows the action's notice and `denied` (declined) shows
  nothing. `failed` says the launcher showed its own message, since the worker never learns it. `busy` and
  `cancelled` are named. `/dev-reload` shows the server's `{message}` (e.g. "No dirty plugins"). `/devices` sign-out
  of "this device" on loopback is refused by the launcher (`denied`, "Not signed out"), because the device owner has
  no cookie.
- `ListOverlay` footers wrap (at most three lines each), and `TextViewer` passes the width to its lines, so Markdown
  wraps.

### 10.6 As built: working directory and environments (`/cd`, `/new [env:]path`)

Tests: `P2/test/p2/tui-location.test.ts`. Code: `P2/plugins/sessions/tui-location.ts`, `P2/plugins/sessions/tui.ts`.

- **Form.** A location is written as the footer writes it, `[env:]path` (`gpu:/data`). No prefix is this device for
  `/new`, and the session's own environment for `/cd` (cd semantics). `local:` names this device, unless an
  environment is called "local". A prefix naming no configured environment is refused ("Unknown environment …")
  unless it is one letter, which reads as a Windows drive. Relative paths join the session's directory for `/cd`
  (`..` and `.` resolved, either separator style), and the home directory otherwise (`~/rel`). The server expands `~`
  on the target machine.
- **`/cd [[env:]path]`** (owner, the web's Relocate in the session sheet):
  - It resolves and checks the location with `Envs.listDirectory`, as the web's DirectoryPicker does before "Use", then
    calls `Sessions.relocate` with the listed (canonical) path.
  - Moving to another environment is confirmed with the web's note ("Tools will run on X. The history stays; files
    are not copied.").
  - Errors are the server's message, as on the web (ENOENT, SSH failures, "Stop the current run before changing
    directory").
  - The footer follows the catalog.
  - Without an argument, a prompt opens with the environment choice. Its note stands above the input, and Enter is
    the confirmation, like the web's "Move session to" button.
- **Completion.** Tab completes the argument of `/cd` and `/new`: environment names (`gpu:`), then the typed
  directory's subfolders from `Envs.listDirectory` (dot folders only after a typed dot). **Deviation:** not
  `FileIndex`, which is confined to the session directory and its environment and cannot reach parents, `~` or another
  environment.
- **Environments.** The "+ New session" prompt (sessions screen) and the `/cd` prompt choose the environment with Tab:
  this device, then each configured environment, starting at that machine's `~` (the web picker's environment select
  browses `~`). The first use acquires `Envs` and calls `warm` (the web's SSH warm-up). The reference is held while in
  use and released 30 s after the last request. Guests never acquire it (tested).
- **`/new [[env:]path]`** creates there (`/new gpu:/data`); without an argument it creates in the viewed session's
  env:cwd as before. A bare path used to take the default environment; it now means this device, matching the footer
  form.
- **`/envs` moves sessions** (the owner's "we only need envs"):
  - **Screen.** The first row is "This device", then the configured environments. The viewed session's environment
    is marked "●" and "this session", and selected when the screen opens.
  - **Enter** moves the session there: the directory prompt opens on that environment. It is prefilled with the
    session's directory when it exists there (checked with `Envs.listDirectory`), else with that machine's home (its
    listed path). An unreachable environment's error shows under the input.
  - **Confirmation.** The prompt shows the move note ("Tools will run on X. The history stays; files are not copied."),
    and Enter confirms, as in the `/cd` prompt. Then `Sessions.relocate`. Escape moves nothing.
  - **The session's own environment:** Enter opens the same prompt without the note, so it works as `/cd`.
  - **Wiring.** Moving belongs to the sessions plugin, which already imports the envs contract, so `/envs` reaches it
    through a host registry: `TuiSessionPlaces` (`P2/src/runtime/tui-sessions.ts`, `where` and `moveTo`). Without the
    sessions plugin, `/envs` only manages environments.
  - **Not changed.** `/cd [[env:]path]` stays as a shortcut.
  - The web DirectoryPicker port (folder browser) asked for earlier is not built yet.
- **/hotkeys** shows each command's argument hint (`/cd [[env:]path]`) and, for owners, a "Working directory and
  environment" section: Tab in the prompts, the `[env:]path` form, `/cd` rules, and what Enter and the secondary keys
  do in `/envs`.
- **Prefilled inputs.** pi-tui's `Input.setValue` keeps the cursor where it was (0), so typing after a prefilled
  directory or title went in front of it. The prompts now fill the input by typing it (`fillInput`).
- **Command completion** (`P2/src/runtime/tui-commands.ts`):
  - `slash.tabOnly` makes argument completion run on Tab only, never while typing, so Enter submits a typed path
    instead of accepting a listed subfolder.
  - A forced Tab inside a command's argument now asks the command's `complete` (pi's argument completions).
    `P2/src/tui/completion.ts` falls back to file completion when the command has none.

### 10.7 As built: footer branch, Mermaid (P2 leftover, P12)

- **Git branch** (`P2/plugins/workspace/tui.ts` `GitBranch`, slot `footer:branch`):
  - The footer shows pi's `cwd (branch)` and "detached" for a detached HEAD, as pi does.
  - The branch comes from `Workspace.query({kind: "status"})`, asked when the conversation opens and again when
    `Workspace.changes` advances (500 ms debounce, one query at a time).
  - It is asked only by those who may hold `Workspace`: the owner and full-access guests. View-only guests are refused,
    so they never ask.
  - The status plugin reads it through `runtime.slots("footer:")` and does not depend on the workspace plugin.
  - Tests: `P2/test/p2/tui-p11.test.ts` (main, then a branch switch after a file change, then detached).
- **Mermaid** (`P2/src/tui/components/mermaid.ts`, registered by the core facet as `00:mermaid`, ahead of plugin
  transformers, as pi puts it before extension transformers):
  - A copy of pi's transformer. The mode comes from the visitor's `markdown.mermaid` setting (default `streaming`, as
    pi) and the colors from the instance theme. Thinking blocks are never transformed, too-wide diagrams keep their
    source, and invalid ones say why once complete.
  - **Deviation:** `MarkdownTransformContext` carries `theme` and `settings`. pi's transformers close over its global
    theme and settings manager; p2's are registry entries shared by all instances (5.4).
  - `grok-mermaid` 0.2.3 was checked to be pure (no dependencies; no fs, process, network or eval) and added to p2's
    dependencies. The lockfile changed only in p2's dependency list (the package was already installed for
    coding-agent).
  - Tests: `P2/test/p2/tui-mermaid.test.ts`. The sandbox test in `P2/test/p2/tui-render.test.ts` renders a diagram
    inside the real permission-dropped worker.
- **`/envs` warm-up.** Opening the screen calls `Envs.warm`, as the web's directory picker does.

### 10.8 As built (P12): shell, skills and templates, fork and clone

#### `Chat.shell`: `!cmd` and `!!cmd` (as built)

Tests: `P2/test/p2/shell.test.ts` (a bare session host with real Durable and a real local environment),
`P2/test/p2/tui-shell.test.ts`.

- **What pi does** (`IM:3346-3360`, `CA/core/messages.ts:30`):
  - `!cmd` runs a shell command and shows a bash execution component with its output streaming.
  - The result becomes a `bashExecution` message. It is in the model's context ("Ran `cmd`" plus the output) but starts
    no run. `!!cmd` is the same, excluded from the context.
  - One command at a time; Escape cancels.
- **Contract.**
  - `Chat` is version 4 (versions 2 and 3 are accepted as they are).
  - Participants get `shell({command, includeInContext, requestId})` → `{shellId}` (the `requestId`, so a TUI shows
    the command's block under its final ID before the state arrives) and `abortShell({shellId})` → `{aborted}`.
  - Both variants get the state `liveShell` (a state member cannot share the method's name):
    `{id, command, author, includeInContext, output, truncated, running, exitCode?, cancelled, error?} | null`.
  - **Who may:** anyone who may send, so full guests too, as tools run commands for them. Viewers watch.
    One-shot agents' conversations are refused (the `ReadOnlyConversations` check).
  - **Cancelling:** the command's author or the owner.
  - **One at a time per conversation;** a second command is refused with pi's text (`SHELL_BUSY`).
  - **Retries:** a call with the same request ID runs once.
- **Worker** (`P2/plugins/chat/shell.ts`; the worker's `ShellCommands` object, which `Chat` holds):
  - A command is a Chord job (`p2.shell-commands.run`): `Chat.shell` returns once the run is started (committed with
    the request ID it dedupes, among the last 100 starts per author), so `liveShell` shows it when the call answers.
  - The command runs on the conversation's environment, `Harness.environments.at(agent.cwd)`: local or remote, and
    a subagent's own cwd.
  - It uses the bash tool's settings (`inheritEnv`, spill and an output window at Durable's 2000 lines / 50 KiB,
    sampled every 200 ms at 100 KiB/s).
  - The kept tail is the run's state document, which `liveShell` shows.
  - A running job keeps the worker up (`host.activity.jobs`) and counts as one active call (`Liveness`, from before
    its start until its run ends), so a move or a clone waits for it. `abortShell` aborts the run and answers once
    `liveShell` shows it cancelled. A reload of the chat plugin or the worker's end aborts it.
  - When it ends, a Durable write submission places a `p2.shell` entry (`P2/src/runtime/shell.ts`, `ShellData`:
    author, command, output tail, `exitCode`, `cancelled`, `truncated`, `fullOutputPath`, `includeInContext`, `error`).
  - **`!`:** the entry also carries a user message (the sender block plus pi's `bashExecutionToText`,
    `shellContextText`). The agent reads it on its next run, and no run starts now.
  - **`!!`:** the entry is display-only.
  - **Busy agent:** while the agent runs, the entry is placed at the run's next boundary, like any write. The run
    waits for the placement, so `liveShell` clears once the entry shows.
  - The data has no `text` field, so no reader takes it for a person's message.
  - **Deviation:** a command is not refused during a compaction; the write's placement keeps the order.
- **TUI** (`P2/plugins/chat/tui.ts`):
  - **Bash mode:** `!` text turns the editor border to `bashMode`. Enter on `!cmd`/`!!cmd` calls `Chat.shell`; a lone
    `!` is an ordinary message.
  - **Live command:** a copy of pi's `BashExecutionComponent` (`P2/src/tui/components/bash-execution.ts`: instance
    theme, sanitized output, loader only while live, the author named for guests' commands). It is the transcript's
    new `tail`, at the end like pi's chat flow.
  - **Escape, in pi's order:** the running agent, then the running command, then bash mode's text (cleared), then the
    double Escape.
  - **Entries:** finished `p2.shell` entries render with the same component, through an entry renderer registered by
    the core facet. The entry kind is the host's.
  - **Why the core facet:** registering it from the chat facet made a reload of that facet rebuild the renderers
    mid-reload, and Ctrl+End stopped following (`tui-render` "reading position"). That rebuild problem remains for
    any facet that contributes entry renderers.
- **Web:** the entry is a plain notice: a marker `$ command` whose detail is the output in a fenced block, how it
  ended, and who ran it (`P2/src/web/transcript.ts`). There is no live view and nothing to start commands.

#### `/skill:<name>` and prompt templates (as built)

- **pi's behavior, copied** (`P2/plugins/prompt/templates.ts`, from `CA/core/prompt-templates.ts`,
  `CA/utils/frontmatter.ts` and `CA/core/agent-session.ts` `_expandSkillCommand`; no runtime imports): templates are
  `.md` files with optional frontmatter `description` (else the first line, 60 characters) and `argument-hint`, used
  as `/<name> args`; arguments split bash-style with quotes and substitute `$1`, `$@`, `$ARGUMENTS`, `${N:-default}`,
  `${@:-default}`, `${@:N}`, `${@:N:L}` without recursion. `/skill:<name> args` becomes
  `<skill name location>References are relative to <dir>.\n\n<body></skill>` plus the args. Skill expansion comes
  first, then the first template of that name; unknown names and unreadable skills stay as typed. Skills hidden from
  the model (`disable-model-invocation`) are still invocable, as in pi.
- **Locations** (the session's environment, like skills): `<data>/prompts` locally or `~/.pi/p2/prompts` on a remote
  environment (global, listed first, so it wins a name clash), then `<cwd>/.pi/prompts` (project). Only files directly
  in those directories; symbolic links are not followed; an unreadable or unparsable template is skipped. They are
  loaded with AGENTS.md and skills (`loadPromptResources`, `P2/plugins/prompt/context-files.ts`) and the prompt
  observer watches both directories, so changes reload live.
- **Contract** (`P2/plugins/prompt/contract.ts`): `PromptResources({session})`, served by the session worker to
  participants only (`canSend`; viewers are refused). State `templates: [{name, description, argumentHint?, source}]`
  and `skills: [{name, description}]`; method `expand({text})` → `{text, skill?: {name}}`, which reads skill files
  through the session's environment when invoked. Decision on the open point: a separate method, not a `Chat.send`
  flag, so both clients use it and `send` stays unchanged.
- **TUI** (`P2/plugins/prompt/tui.ts`): a slot surface (no rendering) holds `PromptResources` of the viewed session
  for owners and full-access guests, and contributes a `TuiSlashSources` entry (`P2/src/runtime/tui-commands.ts`).
  Slash completion lists templates (with their argument hint) and `skill:<name>` after the commands, matching skills
  by their bare name first (pi's order); an entry with a command's slash name is neither listed nor expanded. On
  Enter, the chat editor expands a `/template` or `/skill:` through `ctx.commands.expand` (the worker method) and sends
  the result (one small hook in `P2/plugins/chat/tui.ts`). A user message that is a skill block renders as pi's
  collapsed `[skill] <name>` block (`P2/src/tui/components/skill-invocation.ts`, a copy of
  `CMP/skill-invocation-message.ts`), expanded with the tool toggle (Ctrl+O), followed by the user's own text.
- **Web**: the composer asks the `ComposerExpanders` registry (`P2/src/runtime/composer.ts`) before a send; the
  prompt plugin's web facet (`P2/plugins/prompt/web.tsx` → `composer.ts`) expands through the same worker method.
  No completion UI in the web; the new-session composer does not expand (its session does not exist yet).
- **Tests:** `P2/test/p2/prompt-templates.test.ts` (substitution and parsing, the loader, the worker object with live
  reload, expand, the viewer refusal and the web expander, the TUI completion and expansion through a worker stub,
  the skill block component, and a real worker driven through the launcher).

#### `/fork` and `/clone`: `Sessions.fork` and `Sessions.clone` (as built)

Tests: `P2/test/p2/fork-clone.test.ts` (real server and workers, fake provider), `P2/test/p2/tui-fork.test.ts`.

- **What pi does:**
  - `/clone` duplicates the current session at its current position.
  - `/fork` opens a selector of the user's messages. The new session holds the history before the chosen message, and
    the editor receives that message's text.
  - `doubleEscapeAction: "fork"` opens the same selector.
- **Contract.** `Sessions` is version 3 (version 2 is accepted as it is). The owner gets `clone({id})` → `Session`
  and `fork({id, conversation, before})` → `Session`, where `before` is the chosen message's entry.
- **Open questions, decided conservatively:**
  - The server copies the store.
  - Forking a subagent conversation is refused ("Forking a subagent conversation is not supported yet").
- **`clone`** (`P2/plugins/sessions/server.ts`):
  - It runs inside `SessionHosts.pause` (the relocation machinery, now generic; `relocate` uses it). A running worker
    is fenced first (`WorkerBoundary.prepare`), and refused while it works ("Stop the current run before cloning";
    a running `!` command counts).
  - With the worker stopped, the store is copied as files (`sessions/<id>.sqlite`, `-wal`, `-shm`: closed, they
    belong together), together with `artifacts/<id>`, `downloads/<id>` and `uploads/<id>` (`P2/plugins/sessions/copy.ts`:
    0700 directories, 0600 files, links skipped, nothing overwritten). The worker then restarts if it ran.
  - **Deviation:** a file copy of the stopped store instead of SQLite's online backup.
  - **The catalog entry comes last,** under the copy's pre-chosen ID (`Catalog.create` takes an optional `id`):
    same cwd, env, model and level, title "<title> (copy)". A failed copy is removed.
  - Subagent conversations come along in the store. Their sidebar entries appear when the copy's worker reports
    them (`ChildStore`); nothing to copy there.
- **`fork`:**
  - **Export.** The source worker exports the history through `SessionTransfer.history` (a new server-only object,
    `P2/plugins/sessions/contract.ts`). It is the Durable context as of the entry before `before` (`context({at})`),
    as entry drafts: kind, data, the model messages with context edits applied (`contributions`, so no edit refers to
    an old ID), and `head: "self"` on a leading head marker. A fork thus holds the active context, not entries before
    a compaction.
  - **Seed.** The server copies the per-session directories, creates the entry ("<title> (fork)"), and the new
    session's worker writes the drafts into conversation 1 in one commit (`SessionTransfer.seed`, refused when it has
    history) before the ID is returned.
  - Forking before the first message gives an empty session. A failed seed archives the new entry.
  - **Deviation:** a fork's `/artifacts` index (a Durable document) is not rebuilt; its artifact cards work, because
    the files are copied.
- **TUI** (`P2/plugins/chat/tui.ts`, `tui-commands.ts`; in the chat plugin because the picker needs the loaded
  transcript and sessions cannot import chat):
  - **`/fork`** (`app.session.fork`, owner) opens a copy of pi's `UserMessageSelectorComponent`
    (`P2/src/tui/components/user-message-selector.ts`) over people's messages in the loaded transcript, newest
    selected. Enter forks, opens the new session with the message in its editor (its draft), and says "Forked to new
    session".
  - **`/clone`** (`p2.session.clone`, owner) opens the copy ("Cloned to new session").
  - **Double Escape:** `doubleEscapeAction: "fork"` opens the picker on a second Escape within 500 ms on an empty,
    idle editor (owner); `"tree"` (the default, as in pi) opens `/tree` (`docs/tree.md`).
- **Web:** no UI yet.

---

## 11. Copy checklist (dependency removal)

Every copied file must pass this checklist and a smoke test **inside the real permission-dropped worker**: bundle it,
render it in `P2/test/p2/tui-launcher.test.ts`'s sandboxed session, and assert that no `Unavailable in the TUI sandbox` /
permission errors occur.

General removals:

- `node:fs`, `node:child_process`, `node:os` homedir/platform, `process.env`, `process.platform`;
- clipboard, browser opening and the external editor;
- `ModelRuntime`, `SessionManager`, `AgentSession` and `SettingsManager`;
- global `theme` and `keyHint`;
- `CA/config.ts` path helpers.

Inject data and actions through constructor parameters. Copy pure helpers.

| File | Remove / replace |
| --- | --- |
| `CMP/session-selector.ts` | `spawnSync` `trash`, `existsSync`, `unlink` (`CMP/session-selector.ts:1-4`, delete at `:654-687`) → `Sessions.archive`; `canonicalizePath` (`:18`, `:51-53`) and `os` homedir (`:4`, `:27`) → server-provided display paths; `SessionInfo` → p2 rows |
| `CMP/session-selector-search.ts` | Keep the pure parsing; drop regex/phrase support or keep it for local title filtering only (1.17) |
| `CMP/extension-editor.ts` | `editInExternalEditor` and `process.env.VISUAL/EDITOR` (`CMP/extension-editor.ts:17`, `:59-61`) → launcher `externalEditor` grant |
| `CMP/login-dialog.ts` | `openBrowser` (`CMP/login-dialog.ts:3`, `:99-110`) → `openUrl` C grant; `process.platform` hint (`:124`); the `> value` echo (`:80-83`) → secret mode |
| `CMP/auth-url.ts` | `copyToClipboard` (`CMP/auth-url.ts:2`, `:31-34`) → `copy` C grant; platform click hint (`:26`) → guest platform from `capabilities` |
| `CMP/model-selector.ts` | `ModelRuntime` and `refreshModelCatalogs` (`CMP/model-selector.ts:12-13`, `:59`, `:76-94`, `:153-158`, `:162-208`) → injected model list, current/default and a refresh action (`ProviderLogin.refresh`) |
| `CMP/tool-execution.ts` | `ensurePngTranscoder`; `MouseRegion` kept only with mouse mode; global theme (5.3) |
| `REN/read.ts` | `node:path` cwd resolution, `getReadmePath`, `resolveToCwd` → display relative to the session cwd from `Sessions` |
| `REN/edit.ts` | `computeEditsDiff` (local fs) → `details.diff` only |
| `CA/core/tools/render-utils.ts` | `node:os` homedir, `pathToFileURL` hyperlinks, `resolvePath` → plain relative display |
| `CMP/footer.ts` | `AgentSession`, `FooterDataProvider`, `process.env.HOME` → 1.16 data |
| `CMP/bash-execution.ts` | local output paths; keep the rendering |
| `THM/theme.ts` | Section 5.3 |
| `CMP/custom-editor.ts` | `AppKeybinding` typing → command dispatcher; paste-image hook removed |
