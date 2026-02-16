# Explanation: Mu extensions

## What an extension *is* in Mu

An extension is **host-owned code** that runs inside the `mu` process and registers capabilities into a small set of registries:

- tools (LLM-callable functions)
- hook chains (input/context/tool interception)
- slash commands
- runtime model providers

This is deliberately simpler than MCP-style “remote tool servers”: the host loads code and owns the lifecycle.

## Why extensions must be self-contained

Mu discovers extensions in user/project directories (like `~/.mu/agent/extensions`). Those directories do **not** contain the mu repo’s internal source files.

So an extension that imports repo-internal modules like:

```ts
import { eraseAgentTool } from "../types.js";
```

will break when it’s copied outside the repo.

A “proper” extension instead imports from stable, published packages (`@kennyfrc/mu-ai`, `@sinclair/typebox`, etc.) and keeps its own helpers in the same file (or ships them alongside).

## Tool text vs tool behavior

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

## Why there isn’t an extension API for system-prompt fragments (yet)

Extensions can already inject instruction-like text via `context(...)` (because it runs before each provider call).

A dedicated “system prompt fragment registry” is possible, but it adds complexity:
- ordering and conflict resolution across extensions
- update semantics on `/reload`
- testing “prompt shape” drift

If you need true prompt augmentation, the clean direction is:
- `mu.registerSystemPromptFragment({ id, text, priority })`
- merged at prompt rebuild time alongside runtime tool list
