# Extensions

Mu’s coding agent (`@kennyfrc/mu-coding-agent`) supports a small, host-owned extension runtime.

This document is written in **Diátaxis** style:

- **Tutorial**: learn by building a small extension end-to-end.
- **How-to**: goal-oriented recipes.
- **Reference**: exact behaviors and API surface.
- **Explanation**: design rationale and mental model.

---

## Tutorial: your first extension

You will build a single-file extension that:

1) adds a new LLM-callable tool `get_time`
2) adds a new slash command `/time` that calls the tool (indirectly, by sending a user message)
3) hot-reloads via `/reload`

### 0) Choose where it lives

Mu loads extensions from:

- Global: `~/.mu/agent/extensions/`
- Project: `./.mu/extensions/` (relative to your cwd)

For this tutorial, use the **project** location so the extension travels with the repo:

```bash
mkdir -p .mu/extensions
```

### 1) Create a single-file extension

Create `./.mu/extensions/time.ts`:

```ts
import type { AgentTool } from "@kennyfrc/mu-ai";
import { Type } from "@sinclair/typebox";

export default function (mu: { registerTool: (t: AgentTool<any, any>) => void; registerCommand: (c: any) => void }) {
	const tool: AgentTool<typeof Type.Object({}), { epochMs: number }> = {
		name: "get_time",
		label: "get_time",
		description: "Return the current time as epoch milliseconds.",
		parameters: Type.Object({}),
		execute: async () => {
			return {
				content: [{ type: "text", text: String(Date.now()) }],
				details: { epochMs: Date.now() },
			};
		},
	};

	mu.registerTool(tool);

	mu.registerCommand({
		name: "time",
		description: "Ask the agent for the current time (via get_time tool)",
		execute: async (_argString: string, ctx: { send: (t: string) => Promise<void> }) => {
			await ctx.send("Call get_time and print it.");
		},
	});
}
```

Notes:
- Keep extensions **self-contained**. Avoid relative imports like `../types.js` (repo-internal).
- Prefer package imports (`@kennyfrc/mu-ai`, `@sinclair/typebox`, etc.).

### 2) Start mu and reload

Start `mu` from the project root, then run:

```
/reload
```

You should see a “Reloaded extensions: … ok” message.

### 3) Try the slash command

Type:

```
/time
```

Expected behavior:
- you should see the agent call `get_time`
- you should see an answer containing the returned epoch milliseconds

### 4) Iterate with hot reload

Edit the tool description or output, then run `/reload` again.

A good quick check is changing the tool description line and verifying that the system prompt’s `Available tools` list updates accordingly.

---

## How-to: common extension tasks

This section is a set of recipes. It assumes you already know what extensions are and just need to accomplish a concrete goal.

### Add a new LLM-callable tool

1) Create `~/.mu/agent/extensions/my-tools.ts` (global) or `./.mu/extensions/my-tools.ts` (project).
2) Default-export a function.
3) Call `mu.registerTool(tool)`.
4) Run `/reload`.

Minimal skeleton:

```ts
import type { AgentTool } from "@kennyfrc/mu-ai";
import { Type } from "@sinclair/typebox";

export default function (mu: { registerTool: (t: AgentTool<any, any>) => void }) {
	const tool: AgentTool<typeof Type.Object({ q: Type.String() })> = {
		name: "my_tool",
		label: "my_tool",
		description: "One-line summary used in the system prompt.",
		parameters: Type.Object({ q: Type.String() }),
		execute: async (_id, args) => {
			return { content: [{ type: "text", text: `q=${args.q}` }], details: undefined };
		},
	};

	mu.registerTool(tool);
}
```


### Add a CLI tool (argv passthrough + JSONL stdout)

Use this when you want to wrap an external CLI without mirroring its full flag matrix into a large tool schema.

The CLI should support `--jsonl` and emit JSONL records on stdout (with diagnostics on stderr).

```ts
export default function (mu) {
	mu.registerCliTool({
		name: "web_fetch",
		description: "Fetch a URL via the webfetch CLI (JSONL mode)",
		command: "webfetch",
		// fixedArgs: [],
		// jsonlFlag: "--jsonl", // default
		progress: "stderr", // default
	});
}
```

Tool parameters are stable:

- `argv: string[]` — passed verbatim (no shell)
- `stdin?: string` — optional stdin

Note: if `argv` includes `--help` or `-h`, Mu will *not* auto-append `--jsonl`, and will return the CLI help text as-is.

### Add a slash command

```ts
export default function (mu) {
	mu.registerCommand({
		name: "hello",
		description: "Say hello",
		execute: async (argString, ctx) => {
			ctx.print(`hello: ${argString}`, { color: "dim" });
		},
	});
}
```

### Block or patch tool calls

Block:

```ts
mu.beforeToolCall((ev) => {
	if (ev.toolName === "bash") return { type: "block", reason: "bash disabled" };
	return { type: "noop" };
});
```

Patch args:

```ts
mu.beforeToolCall((ev) => {
	if (ev.toolName === "read" && typeof ev.args === "object" && ev.args && "path" in ev.args) {
		return { type: "patch", args: { ...(ev.args as any), limit: 50 } };
	}
	return { type: "noop" };
});
```

### Patch tool results

```ts
mu.afterToolResult((tr) => {
	if (tr.toolName !== "read") return;
	return {
		...tr,
		content: [{ type: "text", text: "(redacted)" }],
	};
});
```

### Inject context before each model call (prompt-like behavior)

```ts
mu.context((messages) => {
	return [
		{ role: "user", content: "(extension note) prefer rg over grep", timestamp: Date.now() },
		...messages,
	];
});
```

This is the supported way for extensions to add **per-call** “prompt-like” instructions today.

### Keep extensions portable (no legacy imports)

Do:
- import from packages (e.g. `@kennyfrc/mu-ai`, `@sinclair/typebox`)
- keep extensions single-file when you can

Avoid:
- relative imports into the mu repo build output, like `../types.js`
- relying on sibling helper files unless you ship them alongside your extension

### Debug why an extension isn’t loading

1) Run `/reload`.
2) Read the error and file path.
3) The most common cause is a relative import to a file that doesn’t exist where the extension lives.

---

## Reference

### Discovery locations

On startup (and on `/reload`), Mu discovers extensions in this order:

1. Global: `~/.mu/agent/extensions/`
2. Project: `./.mu/extensions/` (relative to your current working directory)

Only JS/TS module files are loaded (`.ts`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`). Type declaration files are ignored.

### Duplicate extension files (`.ts` + `.js`)

If both `my-extension.ts` and `my-extension.js` exist with the same basename, Mu loads only one:
- prefers TypeScript source (`.ts` / `.mts` / `.cts`)
- otherwise falls back to JavaScript (`.js` / `.mjs` / `.cjs`)

This avoids accidental double-registration.

### Extension file format

Each extension file must default-export a factory function:

```ts
export default function (mu) {
  // mu is the ExtensionApi
}
```

The factory is executed once per load. On `/reload`, the old extension is unloaded (registrations removed by `sourceId`), then the module is re-imported and executed again.

### Tool visibility in system prompt

The `Available tools` section in the system prompt is built from the **actual runtime tool list** (built-ins + extension tools), not just built-ins.

For extension tools:
- Mu uses your tool's `name`
- Mu uses a short description derived from your tool's `description` (first non-empty line, trimmed)

### API surface (ExtensionApi)

#### Tools

```ts
mu.registerTool(tool, { priority })
```

- Tools are stored in a registry with ownership (`sourceId`).
- If multiple tools share the same name, the active one is chosen by:
  1) highest `priority`
  2) last-write-wins for ties

#### Tool interception

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

#### Context preprocessor (per model call)

```ts
mu.context((messages, abortSignal) => {
  // return a new Message[] to transform/prune/inject
})
```

This runs **before every provider call**, not just once per user prompt.

#### Input hooks

```ts
mu.input((text) => {
  return { type: "transform", text: "..." }
  // or { type: "handled" }
  // or { type: "noop" }
})
```

Input hooks run before built-in parsing. `handled` short-circuits submission.

#### Slash commands

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

#### Runtime providers/models

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

### Priority & ordering summary

- Hook execution: **priority desc**, then **registration order** for ties.
- Tool/command selection: **priority desc**, then **last-write-wins** for ties.
- Runtime provider selection (per provider name): **priority desc**, then **last-write-wins** for ties.

---

## Explanation

### What an extension is in Mu

An extension is **host-owned code** that runs inside the `mu` process and registers capabilities into a small set of registries:

- tools (LLM-callable functions)
- hook chains (input/context/tool interception)
- slash commands
- runtime model providers

This is deliberately simpler than MCP-style “remote tool servers”: the host loads code and owns the lifecycle.

### Why extensions must be self-contained

Mu discovers extensions in user/project directories (like `~/.mu/agent/extensions`). Those directories do **not** contain the mu repo’s internal source files.

So an extension that imports repo-internal modules like:

```ts
import { eraseAgentTool } from "../types.js";
```

will break when it’s copied outside the repo.

A “proper” extension instead imports from stable packages (`@kennyfrc/mu-ai`, `@sinclair/typebox`, etc.) and keeps its own helpers in the same file (or ships them alongside).

### Tool text vs tool behavior

Mu has two layers of tool-related text:

1) **System prompt tool list** (“Available tools”)
   - exists to teach the model what tools exist
   - should match the runtime tool set

2) **Tool definitions** sent to the provider
   - the provider uses these to enable function calling
   - this is the authoritative tool schema + description

In the new system:
- extension tools become visible in the system prompt automatically
- their short description comes from the tool’s own `description`

### Why there isn’t an extension API for system-prompt fragments (yet)

Extensions can already inject instruction-like text via `context(...)` (because it runs before each provider call).

A dedicated “system prompt fragment registry” is possible, but it adds complexity:
- ordering and conflict resolution across extensions
- update semantics on `/reload`
- testing “prompt shape” drift

If you need true prompt augmentation, the clean direction is:
- `mu.registerSystemPromptFragment({ id, text, priority })`
- merged at prompt rebuild time alongside runtime tool list
