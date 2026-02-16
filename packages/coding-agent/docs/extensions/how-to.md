# How-to: Mu extensions

This page is a set of recipes. It assumes you already know what extensions are and just need to accomplish a concrete goal.

## Add a new LLM-callable tool

1) Create `~/.mu/agent/extensions/my-tools.ts` (global) or `./.mu/extensions/my-tools.ts` (project).
2) Default-export a function.
3) Call `mu.registerTool(tool)`.

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

Then run `/reload` in mu.

## Add a slash command

Register a command:

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

## Block or patch tool calls

Use `beforeToolCall`:

- block:
```ts
mu.beforeToolCall((ev) => {
	if (ev.toolName === "bash") return { type: "block", reason: "bash disabled" };
	return { type: "noop" };
});
```

- patch args:
```ts
mu.beforeToolCall((ev) => {
	if (ev.toolName === "read" && typeof ev.args === "object" && ev.args && "path" in ev.args) {
		return { type: "patch", args: { ...(ev.args as any), limit: 50 } };
	}
	return { type: "noop" };
});
```

## Patch tool results

Use `afterToolResult` to redact or annotate outputs:

```ts
mu.afterToolResult((tr) => {
	if (tr.toolName !== "read") return;
	return {
		...tr,
		content: [{ type: "text", text: "(redacted)" }],
	};
});
```

## Inject context before each model call

Use `context(...)`:

```ts
mu.context((messages) => {
	return [
		{ role: "user", content: "(extension note) prefer rg over grep", timestamp: Date.now() },
		...messages,
	];
});
```

This is the *supported* way for extensions to add per-call “prompt-like” instructions today.

## Keep extensions portable (no legacy imports)

Do:
- import from packages (e.g. `@kennyfrc/mu-ai`, `@sinclair/typebox`)
- keep extensions single-file when you can

Avoid:
- relative imports into the mu repo build output, like `../types.js`
- relying on sibling helper files unless you ship them alongside your extension

## Debug why an extension isn’t loading

1) Run `/reload`
2) Read the error and file path
3) The most common cause is a relative import to a file that doesn’t exist where the extension lives.
