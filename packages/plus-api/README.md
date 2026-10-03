# plus-api

Builds the **`pi-plus-sdk`** npm package: pi with the pi-plus override layer as an
embeddable library, for hosts that run pi in-process (e.g. a desktop app) instead of
running the `pipi` CLI. The CLI counterpart is [`../plus-cli`](../plus-cli) (the
`pi-plus` package); the shared override core is [`../plus`](../plus).

## Usage

```js
import { createPlusAgentSession } from "pi-plus-sdk";

const { session } = await createPlusAgentSession({
	cwd: projectDir,
	ui: {
		select: async (title, options) => showPicker(title, options),
		confirm: async (title, message) => showConfirm(title, message),
		input: async (title, placeholder) => showInput(title, placeholder),
	},
	// Hosts without a pi CLI on PATH should exclude the subagent tool: it
	// launches a pi subprocess and could otherwise relaunch the host app.
	excludeTools: ["subagent"],
});
await session.prompt("Review this repository");
```

- The full pi-plus layer is included: the compaction/context/reasoning overrides are
  baked into `api.js` by the shared bundle-time redirect plugin, and the nine
  non-TUI pi-plus extensions (subagent, tasks, memory, plan, ask-user, hooks,
  context-guard, `/cd`, `/init`) are registered exactly as the CLI wrapper registers them. No CLI
  logic ships in this artifact: no hub command dispatch (`pipi profile ...`), no
  completion, no pipi help text, no banner/vim/tab-title/plain-tools.
- Profile management ships as a library: the curated `@earendil-works/pi-hub`
  surface is re-exported (`src/profiles.ts`) — `loadProfiles/findProfile/
  addProfile/addProfileModel/updateProfile/removeProfile/removeProfileModel/
  renameProfile/setDefaultProfile/clearDefaultProfile/getDefaultProfileName/
  setProfileDefaultModel` for
  `~/.pi/profiles.json`, and
  `materializeProfile/removeProfileDir/profileDirFor/AGENT_DIR/
  syncProfilePackagesToSource` for the per-profile agent dirs. Hosts get the
  exact contract the `pipi` CLI dispatches instead of reimplementing it.
- The pi-plus context settings ship as a library: `readPlusSettings/writePlusSettings`
  and the `get/setAutoCompactThresholdPercent`, `get/setContextFloorTokens`,
  `get/setContextWindowCapTokens` helpers (plus formatters/parsers) manage the
  pi-plus settings store (`<agentDir>/pi-plus-settings.json`) that drives
  auto-compaction trigger math — the same file the pipi TUI `/settings` rows edit.
  Session history management completes the surface: `SessionManager.listAll` to
  enumerate, `SessionManager.search(query)` to match titles and transcript text, and
  `SessionManager.deleteSession(path)` to remove a transcript.
- Provider login ships as a library (`src/auth.ts`): `loginProvider(providerId, { agentDir?, interaction?, signal?, method? })`
  runs pi's model-runtime login flow (OAuth login page / API-key setup — the same
  flow `pipi profile add <name> -p <provider>` triggers) and persists the credential
  to `<agentDir>/auth.json`; `createTerminalAuthInteraction()` provides the readline
  terminal UI for CLI use, and hosts pass their own `AuthInteraction` to drive the
  prompts from a custom UI. pi-plus disables the TUI `/login` (the `interactive-mode`
  and `slash-commands` core redirects are baked in here too), so this is the login
  entry for the whole product.
- `createPlusAgentSession()` extends the upstream `createAgentSession` (re-exported,
  with the whole upstream SDK surface) and always binds extensions once — do not call
  `session.bindExtensions()` yourself. Pass `ui` dialog handlers to get working
  `ask_user` questions (bound with mode `"rpc"`, so the tool falls back to sequential
  select/input/confirm dialogs bridged to your UI); omit `ui` for a headless session.
- `createPlusAgentSessionRuntime()` returns an `AgentSessionRuntime` instead of a
  single session: the same pi-plus layer and one-bind-per-session rules, plus the
  CLI's session-replacement machinery — `runtime.cd`-style switches
  (`switchSession`), `newSession`, and `fork` (with `{position: "at"}` for the CLI's
  in-place `/clone`). The pi-plus `/cd`/`/init` extensions and anything else needing
  `commandContextActions` work out of the box: the factory wires runtime-routed
  actions by default (override via the `commandContextActions` option). The live
  session is `runtime.session` and **changes on every replacement** — re-subscribe in
  the `onRebind` callback (it also fires for the initial bind) and never call
  `bindExtensions()` yourself. `runtime.dispose()` is async and emits
  `session_shutdown`.
- `session.setAutoCompactionEnabled(bool)` writes the **global**
  `<agentDir>/settings.json` compaction flag (not a per-session setting), so a host
  toggle labeled per-session would surprise users — it also flips behavior for the
  `pipi` CLI sharing that agent dir.
- The staged `package.json` has an `exports` map, so deep imports are not reachable;
  `api.d.ts` re-exports the `@earendil-works/pi-coding-agent` types (exact-pinned
  dependency, type resolution only — the runtime is self-contained).
- `main` is re-exported from the upstream barrel but redirects to a stub that throws:
  the CLI entry is not part of the SDK. Likewise `parseArgs`/`Args` and
  `SettingsSelectorComponent` are upstream pi's versions, not the pipi-branded CLI
  wrappers.

## Building the artifact

```bash
npm run build:offline          # at the repo root, first
npm run build                  # in packages/plus-api
npm publish --access public --ignore-scripts   # in packages/plus-api/dist/npm
```

## Tests

```bash
npx vitest run   # from packages/plus-api
```
