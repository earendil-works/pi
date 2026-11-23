# @earendil-works/pi-codemode

Runs model-written JavaScript and TypeScript in a [djs](https://github.com/earendil-works/djs) VM (a JavaScript engine compiled to WebAssembly) where the only capability is calling injected tools. Nested tool calls never enter the LLM context; only the script's output and return value do.

Scripts use `tools`, `ALL_TOOLS`, `text`, `image`, `exit`, `store`, and `load`, and may start with a `// @options:` line. The coding agent uses it for its built-in `codemode` tool. It has no pi dependencies and can be used on its own to expose any functions (remote APIs, MCP servers, application services) to model-written scripts.

Every sandbox runs a script in its own VM, a separate wasm instance. Two sandboxes share one API, one script environment, and one result format:

| Sandbox | Import from | Where scripts run |
| --- | --- | --- |
| `CodemodeSandbox` | `@earendil-works/pi-codemode` or `/portable` | the calling thread (Node, Bun, browsers, Cloudflare) |
| `RemoteCodemodeSandbox` | `@earendil-works/pi-codemode/portable` | a Durable Object in a separately deployed Worker |

See [Usage on Node and Bun](#usage-on-node-and-bun) and [Usage on Cloudflare Workers](#usage-on-cloudflare-workers). Hosts that keep scripts across restarts use the engine directly: see [Saved runs](#saved-runs).

## Usage on Node and Bun

```ts
import { CodemodeSandbox } from "@earendil-works/pi-codemode";

const sandbox = new CodemodeSandbox({
	timeoutMs: 60_000,
	tools: [
		{
			name: "read",
			execute: async (args, { signal }) => {
				const { path } = args as { path: string };
				return await readFile(path, "utf8");
			},
		},
	],
});

const result = await sandbox.execute(`
	const source = await tools.read({ path: "package.json" });
	text("bytes " + source.length);
	return JSON.parse(source).name;
`);

console.log(result.output); // [{ type: "text", text: "bytes 1234" }]
if (result.ok) console.log(result.value); // "@earendil-works/pi-codemode"
else console.error(result.error.kind, result.error.message);

await sandbox.close();
```

`code` is the body of an async function, JavaScript or TypeScript (types are erased), in strict mode: `return` and top-level `await` work. Inside the script, with every sandbox:

- `tools.<name>(args)` returns a promise. Arguments and results make a JSON round trip. A tool that throws rejects with an `Error` carrying the same message. Tool names are also exposed as identifiers: characters that are not valid in identifiers become `_` (`toCodemodeIdentifier`), so `my-tool` is `tools.my_tool` as well as `tools["my-tool"]`.
- `ALL_TOOLS` lists `{ name, description }` for every tool, with `name` as the identifier.
- `text(value)` appends a text item to `result.output`; values other than strings are JSON-stringified. `console.log/info/warn/error/debug` append text items with `console: true`.
- `image(urlOrItem)` appends an image item. It accepts a base64 `data:` URL, `{ image_url }`, or an image block (`{ type: "image", data, mimeType }`, as MCP tools and `@earendil-works/pi-ai` produce). Remote URLs are rejected.
- `exit()` ends the script successfully right away, keeping its output and store writes.
- `globals` passed to the sandbox are called as top-level functions, for example a host helper `image(ref)`. They behave like tools but are not recorded in `result.calls`. A name like `models.classify` puts the function on a frozen `models` object. With `spread: true`, `execute` receives all call arguments as an array instead of the first one, and `signature` replaces the declaration generated from the schemas.
- `store(key, value)` and `load(key)` read and write JSON values synchronously. See [Store](#store).
- Reading a member of `tools` or a global namespace that does not exist throws a `TypeError` that names the close matches.
- Nothing else: no timers, `fetch`, `process`, `require`, or `WebAssembly`. Built-ins are frozen. `eval` and `Function` work but only produce more code inside the same VM.

`timeoutMs: Infinity` disables the deadline; the script then runs until it settles or `signal` aborts it. A script that waits on a promise nothing can settle (no tool call pending, and the VM has no timers or I/O) fails right away instead of hanging.

`memoryLimitBytes` caps the VM's heap. Past it the script fails with `InternalError: out of memory`.

The VM runs on the calling thread. While a script computes, each step yields to the event loop every 10 ms, so the host's timers and I/O, the deadline, and an abort keep working during `while (true) {}`. `fuel` bounds the computation of one execution, across its waits on tools, independently of time: about 1e9 is 2 seconds of a tight loop on an Apple M-series laptop. Past it the execution fails with `kind: "timeout"`.

## Store

`store`/`load` let scripts keep values across executions. The sandbox does not persist anything itself: pass the current values as `options.store`, and a successful result reports what the script changed as `result.storeWrites` (`{ set, delete }`). Failed executions report no writes.

```ts
const result = await sandbox.execute(`store("runs", (load("runs") ?? 0) + 1)`, { store: saved });
if (result.ok) {
	for (const key of result.storeWrites.delete) delete saved[key];
	Object.assign(saved, result.storeWrites.set);
}
```

`load` returns a copy, so mutating it does not change the store. Storing `undefined` deletes the key. A value may be at most `MAX_STORE_VALUE_CHARS` (256 Ki) characters of JSON and all values together at most `MAX_STORE_TOTAL_CHARS` (1 Mi); larger writes throw a `RangeError` inside the script.

## Source format

`parseCodemodeSource()` accepts a script whose first line may be an options line:

```js
// @options: {"max_output_tokens": 2000, "timeout_ms": 30000}
const source = await tools.read({ path: "package.json" });
text(JSON.parse(source).name);
```

Supported fields are `max_output_tokens`, a token budget for the output, and `timeout_ms`, a hard deadline. The sandbox does not act on them; the caller decides. The options line is replaced by an empty line, so line numbers in stack traces still match the input. Empty input, invalid JSON, unknown fields, an options line without code, or an options line on any line but the first throw `CodemodeSourceError`. `CODEMODE_SOURCE_GRAMMAR` is a Lark grammar for providers that support grammar-constrained tool input. Both are also available from the lightweight `@earendil-works/pi-codemode/source` entry.

## Bundled Node and Bun hosts

By default `CodemodeSandbox` loads `@earendil-works/djs/wasm/djs.wasm` from the installed package (`$DJS_WASM` overrides it). The file is not on disk when the host is bundled, so pass the module:

```ts
import { CodemodeSandbox, loadDjsWasm } from "@earendil-works/pi-codemode";

const sandbox = new CodemodeSandbox({
	tools,
	// Compiled once per path and cached.
	wasm: loadDjsWasm(pathToDjsWasm),
});
```

`DJS_WASM_FILE` names the file to resolve, embed, or copy (`require.resolve(DJS_WASM_FILE)`).

## Usage on Cloudflare Workers

Cloudflare Workers cannot compile WebAssembly at runtime, and their clock does not move while code runs, so a script that computes cannot yield on time. Two sandboxes have the same API, the same script environment, and the same `CodemodeResult`. Only where the VM runs differs:

| Sandbox | Where the VM runs | Use it for |
| --- | --- | --- |
| `RemoteCodemodeSandbox` | another isolate, usually a Durable Object in a separate Worker | a Durable Object that runs an agent session |
| `CodemodeSandbox` with a `fuel` budget | the calling thread | a stateless Worker, when blocking the caller is acceptable |

Import them from `@earendil-works/pi-codemode/portable`, which has no Node imports. On Cloudflare, `@earendil-works/pi-codemode/cloudflare` adds the deployable Durable Object and the djs module compiled by Wrangler.

### Why a separate Worker

A script that computes holds its thread until it awaits a tool, because the clock does not move and the VM cannot yield on time. Measured on Cloudflare (October 2026), a script that computed for ten seconds delayed every other request to the session object by the full ten seconds in two placements:

- inside the session's Durable Object
- in a Dynamic Worker loaded by that object

In a Durable Object of a separately deployed Worker, the delay was about 50 ms. `RemoteCodemodeSandbox` therefore keeps the tools and call records in the session and sends only the VM to the sandbox Worker. Each tool call travels back to the session over Workers RPC.

### Deploying the sandbox Worker

A complete setup is in [`examples/cloudflare`](https://github.com/earendil-works/pi/tree/main/packages/codemode/examples/cloudflare). The sandbox Worker is one file:

```ts
// sandbox/src/index.ts
export { CodemodeSandboxDurableObject as CodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";

export default {
	fetch: () => new Response("Not found", { status: 404 }),
};
```

```jsonc
// sandbox/wrangler.jsonc
{
	"name": "pi-codemode-sandbox",
	"main": "src/index.ts",
	"compatibility_date": "2026-04-22",
	"workers_dev": false,
	"preview_urls": false,
	"migrations": [{ "tag": "v1", "new_sqlite_classes": ["CodemodeSandbox"] }],
	"limits": { "cpu_ms": 60000 }
}
```

Install `@earendil-works/pi-codemode` in the sandbox Worker's project and run `npx wrangler deploy`. Wrangler bundles djs (about 1.9 MB) as a compiled WebAssembly module. The object has no routes and keeps no state, and it never uses its storage.

### Using it from the agent's Worker

Bind the class with `script_name`. Binding a class exported from the agent's own Worker would bring back the blocking described above.

```jsonc
// agent/wrangler.jsonc
"durable_objects": {
	"bindings": [
		{ "name": "CODEMODE_SANDBOX", "class_name": "CodemodeSandbox", "script_name": "pi-codemode-sandbox" }
	]
}
```

Then replace the sandbox. Tools, options other than `wasm` and `fuel`, and results stay the same:

```ts
import type { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";
import { RemoteCodemodeSandbox } from "@earendil-works/pi-codemode/portable";

interface Env {
	CODEMODE_SANDBOX: DurableObjectNamespace<CodemodeSandboxDurableObject>;
}

// Before: new CodemodeSandbox({ tools, timeoutMs: 60_000 })
const sandbox = new RemoteCodemodeSandbox({
	tools,
	timeoutMs: 60_000,
	remote: () => env.CODEMODE_SANDBOX.getByName(sessionId),
});
const result = await sandbox.execute(code, { signal, store });
```

Import the sandbox from `/portable` in the agent's Worker. Importing `/cloudflare` would also bundle the djs module there. `remote` is called once per execution and picks the Durable Object that runs it.

- **One object per session**, `getByName(sessionId)`, keeps a session's scripts together. Two scripts of the same session take turns on one thread.
- **One object per execution**, `getByName(crypto.randomUUID())`, runs every script on its own.

Run both Workers locally with `wrangler dev -c agent/wrangler.jsonc -c sandbox/wrangler.jsonc`.

### Limits on Cloudflare

- **Fuel.** While a script computes without calling a tool, no timer can run, and `Date.now()` does not advance. A script that never yields is limited only by its fuel, not by `timeoutMs`. Past the budget, the execution fails with `kind: "timeout"`.
   - The default `DEFAULT_REMOTE_FUEL` of 1e9 is about 2 seconds of a tight loop on an Apple M-series laptop.
   - Keep the budget below the Worker's `cpu_ms` limit (30 seconds by default). Hitting that limit resets the object instead of failing one script.
- **Memory.** Each VM may use up to 32 MiB by default. All VMs in one isolate share its 128 MB.
- **Changing the limits.** The Durable Object caps every request at its own limits, whatever the client asks for. To change them, subclass it in the sandbox Worker:

```ts
import { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";

export class CodemodeSandbox extends CodemodeSandboxDurableObject {
	protected maxFuel = 2_000_000_000;
	protected maxMemoryLimitBytes = 64 * 1024 * 1024;
}
```

- **Aborts and timeouts.** `timeoutMs` and `signal` end the execution in the caller right away, with `kind: "timeout"` or `kind: "aborted"`. The remote VM stops at its next tool call. A remote VM that is computing at that moment keeps running until it calls a tool or uses up its fuel.
- **Output.** The remote sends output with its next call or with the result, so a caller that stops early has the output up to the last call.
- **Billing.** Each execution is one Durable Object request. The sandbox object is billed for wall-clock duration while an execution runs, including time spent waiting on tools.

### On the calling thread

When blocking the caller is acceptable, for example in a stateless Worker that serves one request, run the VM on the caller's thread instead. Nothing extra needs to be deployed:

```ts
import { createCodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";

const sandbox = createCodemodeSandbox({ tools, timeoutMs: 60_000, fuel: 500_000_000 });
const result = await sandbox.execute(code);
```

`createCodemodeSandbox()` passes the djs module Wrangler compiled to `CodemodeSandbox`, with a fuel budget of `DEFAULT_REMOTE_FUEL` unless given. With another bundler, import `CodemodeSandbox` from `/portable` and pass your own compiled module as `wasm`. A script that computes blocks the caller until it awaits a tool or uses up its fuel.

## Declarations for the model

Tools and globals can carry `description`, `inputSchema`, and `outputSchema` (JSON Schema). `renderDeclarations()` turns them into TypeScript declarations for a model-facing tool description:

```ts
renderDeclarations({ tools: sandbox.tools, globals: sandbox.globals });
// declare const tools: {
//   /** Read a file */
//   read(args: {
//     path: string;
//   }): Promise<string>;
// };
```

Property descriptions become `//` comments. Constraints the type cannot express follow as tags, such as `// @integer @minimum 1 @default 20`; they are dropped first when a type exceeds the size limit. Schemas only shape the declarations; values are not validated against them. Local references (`#/$defs/...`, `#/definitions/...`) are expanded; recursive and remote references render as `unknown`.

## Using with pi-agent-core

To give an `Agent` a codemode tool, expose its other tools to the sandbox and wrap `execute()` as an `AgentTool`:

```ts
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type CodemodeJsonSchema,
	CodemodeSandbox,
	type CodemodeTool,
	renderDeclarations,
} from "@earendil-works/pi-codemode";
import { obj, str } from "@earendil-works/pi-schema";

const sandboxTools: CodemodeTool[] = agentTools.map((tool) => ({
	name: tool.name,
	description: tool.description,
	inputSchema: tool.parameters as CodemodeJsonSchema,
	outputSchema: (tool.outputSchema as CodemodeJsonSchema | undefined) ?? { type: "string" },
	execute: async (args, { signal }) => {
		const result = await tool.execute("nested", args as never, signal);
		if (tool.outputSchema && result.structuredContent !== undefined) return result.structuredContent;
		return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
	},
}));

const codemodeTool: AgentTool = {
	name: "codemode",
	label: "Codemode",
	description: `Run JavaScript that calls tools as \`await tools.<name>(args)\`. Output with text() or return.\n\n${renderDeclarations({ tools: sandboxTools })}`,
	parameters: obj({ code: str() }),
	execute: async (_toolCallId, { code }, signal) => {
		const sandbox = new CodemodeSandbox({ tools: sandboxTools });
		try {
			const result = await sandbox.execute(code, { signal });
			const content = [...result.output];
			if (result.ok && result.value !== undefined) content.push({ type: "text", text: JSON.stringify(result.value) });
			if (!result.ok) content.push({ type: "text", text: result.error.stack ?? result.error.message });
			return { content, details: undefined, isError: !result.ok };
		} finally {
			await sandbox.close();
		}
	},
};
```

`result.output` items already have the shape of `@earendil-works/pi-ai`'s `TextContent` and `ImageContent`. Calling `tool.execute()` directly skips the agent's `beforeToolCall` and `afterToolCall` hooks. To apply them to nested calls too, run each call through `runToolCall()` from `@earendil-works/pi-agent-core`, as the [mcp-codemode example](https://github.com/earendil-works/pi/tree/main/packages/agent/examples/mcp-codemode) does. That example also rejects failed nested calls inside the script and combines codemode with MCP tools.

## Saved runs

`DjsCodemode` (`@earendil-works/pi-codemode/djs`, also in the main entry) is the engine under the sandboxes, for hosts that drive a script themselves and keep it across restarts, as pi's durable code mode does. `begin(code, scope)` starts a run; the host advances it, answers its calls by id, and while it waits can save it as JSON and continue it later in another process:

```ts
const djs = await DjsCodemode.load(undefined, { memoryLimitBytes: 256 * 1024 * 1024 });
const vm = djs.begin(code, { tools: [{ name: "read", jsName: "read", description: "" }], globals: [], store: {} });
await vm.advance(signal);
for (const call of vm.calls) queue.add(call); // { id, identity: "tools.read", args }
const saved = vm.save(); // { v: 1, engine: "djs", dump, output, writes, fuelUsed }
vm.dispose();

// Later, anywhere:
const resumed = djs.resume(scope, saved);
resumed.settle(callId, { ok: true, value: "file text" });
await resumed.advance(signal);
if (resumed.result !== undefined) use(resumed.result);
```

Calls are named by identity: `tools.<jsName>` for tools, a global's name, `<specifier>#<export>` for what a script imports from `scope.modules`. A run that ends lists the calls it no longer awaits in `dropped`; the host cancels them. `save()` throws when the run holds a value a dump cannot write (a `WeakMap`, a `Proxy`). Nothing replays: the dump is the script's state.

## Results

`execute()` never rejects for script failures. `result.error.kind` is one of:

| kind      | meaning                                                                     |
| --------- | --------------------------------------------------------------------------- |
| `script`  | the script threw or failed to parse; `stack` points at `codemode.js:<line>` |
| `timeout` | the deadline expired or the fuel ran out |
| `aborted` | `options.signal` fired or `close()` was called |
| `sandbox` | the VM or its transport failed, for example a wasm trap, a module that does not load, or a failed remote |

`result.output` holds the text and image items in the order the script produced them, also for failed executions. The host keeps all of it until the script ends, so output is limited to `MAX_OUTPUT_CHARS` (16 Mi) characters of text and base64 image data and `MAX_OUTPUT_ITEMS` (100000) items. Past either limit the script fails with a `RangeError`, even if it catches the error. `result.calls` lists every tool call with `status: "ok" | "error" | "cancelled"`. A call that is still running when the script returns (not awaited) is aborted through the tool's `signal` and reported as `cancelled`.

## How it works

Each `execute()` creates a djs VM from the compiled module (a few milliseconds): a separate wasm instance with its own linear memory. Everything the script can reach outside the language is a host function: tools and globals are async host functions the host answers, `text`, `image`, `store`, `load`, `exit`, and `console.*` are sync ones whose checks run on the host. No code of this package runs in the VM. Arguments, results, and the return value cross as JSON; the output and store functions get the script's values and turn them into JSON on the host.

The host drives the run in steps: a step runs until the script waits on its calls or ends, and yields to the event loop every 10 ms while it computes. The deadline and the abort signal stop a step between its slices.

## Runtime notes

- Stack traces use the VM's frames (`at f (codemode.js:2:31)`), prefixed with `Name: message` like V8. Line and column numbers match the script.
- Deep recursion throws a catchable `RangeError`.
- djs is an interpreter. Glue code and filtering tool results are fast enough; heavy computation is slower than in V8.
