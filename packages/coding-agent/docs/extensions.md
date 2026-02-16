# Extensions

Mu’s coding agent (`@kennyfrc/mu-coding-agent`) supports a small, host-owned extension runtime.

Extensions can:
- register LLM-callable tools
- intercept/block tool calls and patch tool results
- preprocess messages before each model call (context hook)
- transform/handle user input before it’s parsed
- register slash commands (autocomplete + execution)
- register custom providers/models at runtime (overlay built-ins + `~/.mu/agent/models.json`)

This is designed to be hot-reloadable via `/reload`.

For a Diátaxis-style guide (tutorial/how-to/reference/explanation), see: `docs/extensions/README.md`.

---

## Discovery locations

On startup (and on `/reload`), Mu discovers extensions in this order:

1. Global: `~/.mu/agent/extensions/`
2. Project: `./.mu/extensions/` (relative to your current working directory)

Only JS/TS module files are loaded (`.ts`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`). Type declaration files are ignored.

---

## Tool visibility in system prompt

The `Available tools` section in the system prompt is built from the **actual runtime tool list** (built-ins + extension tools), not just built-ins.

For extension tools:
- Mu uses your tool's `name`
- Mu uses a short description derived from your tool's `description` (first non-empty line, trimmed)

This keeps tool messaging scoped to what each extension actually registers.

---

## Duplicate extension files (`.ts` + `.js`)

If both `my-extension.ts` and `my-extension.js` exist with the same basename, Mu loads only one:
- prefers TypeScript source (`.ts` / `.mts` / `.cts`)
- otherwise falls back to JavaScript (`.js` / `.mjs` / `.cjs`)

This avoids accidental double-registration.

---

## Extension file format

Each extension file must default-export a factory function:

```ts
export default function (mu) {
  // mu is the ExtensionApi
}
```

The factory is executed once per load. On `/reload`, the old extension is unloaded (registrations removed by `sourceId`), then the module is re-imported and executed again.

---

## API surface (ExtensionApi)

### Tools

```ts
mu.registerTool(tool, { priority })
```

- Tools are stored in a registry with ownership (`sourceId`).
- If multiple tools share the same name, the active one is chosen by:
  1) highest `priority`
  2) last-write-wins for ties

### Tool interception

```ts
mu.beforeToolCall((event) => {
  return { type: "block", reason }
  // or { type: "patch", args }
  // or { type: "noop" }
})

mu.afterToolResult((toolResult) => {
  return patchedToolResult
})
```

- `beforeToolCall` hooks run in a chain. A `patch` updates the args passed to later hooks.
- Returning `block` short-circuits execution.
- `afterToolResult` hooks are applied as a patch chain.
- Hook errors are fail-open (ignored).

### Context preprocessor (per model call)

```ts
mu.context((messages, abortSignal) => {
  // return a new Message[] to transform/prune/inject
})
```

This runs **before every provider call**, not just once per user prompt.

### Input hooks

```ts
mu.input((text) => {
  return { type: "transform", text: "..." }
  // or { type: "handled" }
  // or { type: "noop" }
})
```

Input hooks run before built-in parsing. `handled` short-circuits submission.

### Slash commands

```ts
mu.registerCommand({
  name: "hello",
  description: "...",
  execute: async (argString, ctx) => {
    ctx.print("hi")
    await ctx.send("message to agent")
  }
}, { priority })
```

- Registered commands appear in `/` autocomplete.
- Mu routes `/name ...args` to extension commands after built-ins.

### Runtime providers/models

```ts
mu.registerProvider("my-provider", {
  baseUrl: "https://...",
  apiKey: "MY_PROVIDER_API_KEY",
  api: "openai-completions",
  models: [ ... ]
}, { priority })
```

Runtime providers/models are merged as:
1) built-ins (`@kennyfrc/mu-ai`)
2) `~/.mu/agent/models.json`
3) runtime registrations (extensions)

De-duplication key: `(provider, id)`.

API key resolution order:
1) runtime provider `apiKey`
2) `models.json` provider `apiKey`
3) built-in env var resolution (`@kennyfrc/mu-ai`)

---

## Priority & ordering summary

- Hook execution: **priority desc**, then **registration order** for ties.
- Tool/command selection: **priority desc**, then **last-write-wins** for ties.
- Runtime provider selection (per provider name): **priority desc**, then **last-write-wins** for ties.

---

## Hot reload & state

Because extensions are re-evaluated on `/reload`, **do not store durable state in module-level globals**.

Durable state should be derived from:
- session history (tool result details or custom session entries)
- external files



### Session entries (durable extension state)

Extensions can append durable entries to the current session JSONL file:

```ts
mu.appendSessionEntry("my_type", { any: "json" })

mu.appendSessionMessage("my_type", {
  role: "user",
  content: "message text",
  timestamp: Date.now(),
}, { display: "hidden" })
```

- `custom` entries are **not** sent to the LLM automatically; they are for durable state/history.
- `custom_message` entries are loaded by `SessionManager.loadMessages()` on resume/continue.
- Branching (`/branch`) preserves these entries when copying the message prefix into a new session file.
