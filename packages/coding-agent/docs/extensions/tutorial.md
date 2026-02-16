# Tutorial: Your first Mu extension

You will build a single-file extension that:

1) adds a new LLM-callable tool `get_time`
2) adds a new slash command `/time` that calls the tool (indirectly, by sending a user message)
3) hot-reloads via `/reload`

This tutorial assumes you are using `mu` (the coding-agent CLI).

## 0. Choose where it lives

Mu loads extensions from:

- Global: `~/.mu/agent/extensions/`
- Project: `./.mu/extensions/` (relative to your cwd)

For this tutorial, we’ll use the **project** location so the extension travels with the repo:

```bash
mkdir -p .mu/extensions
```

## 1. Create a single-file extension

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
- Keep the extension **self-contained**. Avoid relative imports like `../types.js` (those only exist inside the repo build).
- Use package imports (`@kennyfrc/mu-ai`, `@sinclair/typebox`)—these are resolved from the host.

## 2. Start mu and reload

Start `mu` from the project root, then run:

```
/reload
```

You should see a “Reloaded extensions: … ok” message.

## 3. Try the slash command

Type:

```
/time
```

Expected behavior:
- You should see the agent call `get_time`.
- You should see an answer containing the returned epoch milliseconds.

## 4. Iterate with hot reload

Edit the tool description or output, then run `/reload` again.

A good quick check is changing the tool description line and verifying that the system prompt’s `Available tools` list updates accordingly.

## 5. What you built

- A new tool is registered via `mu.registerTool(...)`.
- A new slash command is registered via `mu.registerCommand(...)`.
- Tool visibility is automatic:
  - the tool is available to the model for calling
  - the tool also appears in the system prompt’s `Available tools` list
