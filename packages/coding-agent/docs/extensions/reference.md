# Reference: Mu extensions

This is the exact, “lookup style” reference.

## Discovery

Directories (in order):

1) `~/.mu/agent/extensions/`
2) `./.mu/extensions/`

Files loaded:
- `.ts`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`
- ignores `.d.ts`, `.d.mts`, `.d.cts`

If both `foo.ts` and `foo.js` exist (same stem), Mu loads only one:
- prefers TypeScript (`.ts/.mts/.cts`)
- otherwise JavaScript (`.js/.mjs/.cjs`)

## Module format

An extension must default-export a factory:

```ts
export default function (mu) {
  // mu is the ExtensionApi
}
```

## ExtensionApi

### Tools

```ts
mu.registerTool(tool, { priority })
```

Selection:
- highest `priority` wins
- ties: last registration wins

### Commands

```ts
mu.registerCommand(command, { priority })
```

Slash command execution:
- Mu routes unknown built-ins to extension commands.

### Hooks

- input:
  - `mu.input(hook, { priority })`
- context:
  - `mu.context(hook, { priority })`
- before tool call:
  - `mu.beforeToolCall(hook, { priority })`
- after tool result:
  - `mu.afterToolResult(hook, { priority })`

Ordering:
- hooks run by **priority desc**, ties preserve registration order

Fail-open behavior:
- hook errors are ignored

### Runtime providers

```ts
mu.registerProvider(name, config, { priority })
```

Merge order:
1) built-ins
2) `~/.mu/agent/models.json`
3) extensions

## Tool visibility in system prompt

Mu’s system prompt `Available tools` list is built from the **runtime tools list** (built-ins + extensions).

For each tool:
- Name: `tool.name`
- Short description:
  - built-ins: from `packages/coding-agent/src/prompts/system.yaml` (`toolDescriptions`)
  - otherwise: derived from the tool’s own `description`

## Reload

- `/reload` unloads and re-imports all extension files.
- Registrations are removed by `sourceId` (the file path).
