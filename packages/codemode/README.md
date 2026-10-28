# @earendil-works/pi-codemode

Runs model-written JavaScript in a QuickJS VM (compiled to WebAssembly) where the only capability is calling injected tools. Nested tool calls never enter the LLM context; only the script's output and return value do.

Scripts use `tools`, `ALL_TOOLS`, `text`, `image`, `exit`, `store`, and `load`, and may start with a `// @options:` line. The coding agent uses it for its built-in `codemode` tool. It has no pi dependencies and can be used on its own to expose any functions (remote APIs, MCP servers, application services) to model-written scripts.

The package runs in two kinds of environments. Each has its own sandbox class, but they share one API, one script environment, and one result format:

| Environment | Sandbox | Import from | Where scripts run |
| --- | --- | --- | --- |
| Node and Bun | `CodemodeSandbox` | `@earendil-works/pi-codemode` | a worker thread per execution |
| Cloudflare Workers and Durable Objects | `RemoteCodemodeSandbox` | `@earendil-works/pi-codemode/portable` | a Durable Object in a separately deployed Worker |

See [Usage on Node and Bun](#usage-on-node-and-bun) and [Usage on Cloudflare Workers](#usage-on-cloudflare-workers). A third sandbox, `InlineCodemodeSandbox`, runs scripts on the calling thread for other runtimes, or on Cloudflare when blocking the caller is acceptable.

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

`code` is the body of an async function: `return` and top-level `await` work. Inside the script, with every sandbox:

- `tools.<name>(args)` returns a promise. Arguments and results make a JSON round trip. A tool that throws rejects with an `Error` carrying the same message. Tool names are also exposed as identifiers: characters that are not valid in identifiers become `_` (`toCodemodeIdentifier`), so `my-tool` is `tools.my_tool` as well as `tools["my-tool"]`.
- `ALL_TOOLS` lists `{ name, description }` for every tool, with `name` as the identifier.
- `text(value)` appends a text item to `result.output`; values other than strings are JSON-stringified. `console.log/info/warn/error/debug` append text items with `console: true`.
- `image(urlOrItem)` appends an image item. It accepts a base64 `data:` URL, `{ image_url }`, or an image block (`{ type: "image", data, mimeType }`, as MCP tools and `@earendil-works/pi-ai` produce). Remote URLs are rejected.
- `exit()` ends the script successfully right away, keeping its output and store writes.
- `globals` passed to the sandbox are called as top-level functions, for example a host helper `image(ref)`. They behave like tools but are not recorded in `result.calls`. A name like `models.classify` puts the function on a frozen `models` object. With `spread: true`, `execute` receives all call arguments as an array instead of the first one, and `signature` replaces the declaration generated from the schemas.
- `store(key, value)` and `load(key)` read and write JSON values synchronously. See [Store](#store).
- Nothing else: no timers, `fetch`, `process`, `require`, modules, or `WebAssembly`. `eval` and `Function` work but only produce more code inside the same VM.

`timeoutMs: Infinity` disables the deadline; the script then runs until it settles or `signal` aborts it. A script that waits on a promise nothing can settle (no tool call pending, and the VM has no timers or I/O) fails right away instead of hanging.

`memoryLimitBytes` caps the VM's heap. Allocations beyond it fail inside the script as `InternalError: out of memory`.

Aborts, timeouts, and `close()` request worker termination without waiting for the worker to exit. On Bun, a built-in such as a long `String.prototype.indexOf` may not poll QuickJS's interrupt handler, so its worker can keep computing until the built-in returns. Stopping unrefs the worker after requesting termination, because `terminate()` refs it internally. This does not guarantee computation has stopped. On Bun 1.4.0, a pending `terminate()` can still delay host process exit despite `unref()`; cancellation results and `close()` do not wait for it.

Hosts that limit concurrency can track actual worker lifetime with `onWorkerStarted(exited)`, called for each worker started by `execute()` or `start()`. Its promise resolves when that worker exits, not when the script result settles:

```ts
const workers = new Set<Promise<void>>();
const sandbox = new CodemodeSandbox({
	onWorkerStarted(exited) {
		workers.add(exited);
		void exited.then(() => workers.delete(exited));
	},
});
```

Keep a concurrency slot occupied until `exited` resolves. `close()` does not wait for these promises.

To enforce an admission limit, pass `acquireWorker()`. It runs synchronously after WASM loading, immediately before each worker is created. Throw to reject the execution without starting a worker; otherwise return a release callback. The sandbox calls it once on actual worker exit or if the worker constructor fails. Share reservation state across sandbox instances, and do not release it when a script result settles.

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

By default `CodemodeSandbox` loads `quickjs-wasi/quickjs.wasm` from the installed package and starts the worker file that sits next to this package's module. Neither exists on disk when the host is bundled, so pass both:

```ts
import { CodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";

const sandbox = new CodemodeSandbox({
	tools,
	// Compiled once per path and cached.
	wasm: loadQuickJSWasm(pathToQuickJSWasm),
	// A file of your build containing `import "@earendil-works/pi-codemode/worker";`
	workerUrl: new URL("./codemode-worker.js", import.meta.url),
});
```

`workerUrl` accepts a URL or string. For a Bun compiled executable, include the worker as an
additional build entrypoint and pass its relative source path as a string, for example
`"./src/codemode-worker.ts"`; Bun resolves that form from its embedded module graph.

## Usage on Cloudflare Workers

`CodemodeSandbox` needs Node or Bun. It runs each script in a worker thread and reads the QuickJS binary from disk. Cloudflare Workers have neither, and they cannot compile WebAssembly at runtime. Two other sandboxes have the same API, the same script environment, and the same `CodemodeResult`. Only where the VM runs differs:

| Sandbox | Where the VM runs | Use it for |
| --- | --- | --- |
| `CodemodeSandbox` | a worker thread | Node and Bun |
| `RemoteCodemodeSandbox` | another isolate, usually a Durable Object in a separate Worker | a Durable Object that runs an agent session |
| `InlineCodemodeSandbox` | the calling thread | anywhere else with WebAssembly, when blocking the caller is acceptable |

Import the last two from `@earendil-works/pi-codemode/portable`, which has no Node imports. On Cloudflare, `@earendil-works/pi-codemode/cloudflare` adds the deployable Durable Object and the QuickJS module compiled by Wrangler.

### Why a separate Worker

QuickJS runs synchronously, so a script that computes holds its thread until it awaits a tool. Measured on Cloudflare (October 2026), a script that computed for ten seconds delayed every other request to the session object by the full ten seconds in two placements:

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

Install `@earendil-works/pi-codemode` in the sandbox Worker's project and run `npx wrangler deploy`. Wrangler bundles QuickJS (about 640 KB) as a compiled WebAssembly module. The object has no routes and keeps no state, and it never uses its storage.

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

Then replace the sandbox. Tools, options other than the worker-specific `wasm`, `workerUrl`, `acquireWorker`, and `onWorkerStarted`, and results stay the same:

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

Import the sandbox from `/portable` in the agent's Worker. Importing `/cloudflare` would also bundle QuickJS there. `remote` is called once per execution and picks the Durable Object that runs it.

- **One object per session**, `getByName(sessionId)`, keeps a session's scripts together. Two scripts of the same session take turns on one thread.
- **One object per execution**, `getByName(crypto.randomUUID())`, runs every script on its own.

Run both Workers locally with `wrangler dev -c agent/wrangler.jsonc -c sandbox/wrangler.jsonc`.

### Limits on Cloudflare

- **Interrupt budget.** While a script computes without calling a tool, no timer can run, and `Date.now()` does not advance. A script that never yields is limited only by the interrupt budget, not by `timeoutMs`. QuickJS polls an interrupt handler while it runs, and the sandbox counts the polls. Past the budget, the execution fails with `kind: "timeout"`.
   - The default `DEFAULT_INTERRUPT_BUDGET` of 100,000 polls is about 2 seconds of a tight loop on an Apple M-series laptop and about 10 seconds on Cloudflare.
   - Keep the budget below the Worker's `cpu_ms` limit (30 seconds by default). Hitting that limit resets the object instead of failing one script.
- **Memory.** Each VM may use up to 32 MiB by default. All VMs in one isolate share its 128 MB.
- **Changing the limits.** The Durable Object caps every request at its own limits, whatever the client asks for. To change them, subclass it in the sandbox Worker:

```ts
import { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";

export class CodemodeSandbox extends CodemodeSandboxDurableObject {
	protected maxInterruptBudget = 200_000;
	protected maxMemoryLimitBytes = 64 * 1024 * 1024;
}
```

- **Aborts and timeouts.** `timeoutMs` and `signal` end the execution in the caller right away, with `kind: "timeout"` or `kind: "aborted"`. The remote VM stops at its next tool call. A remote VM that is computing at that moment keeps running until it calls a tool or uses up its budget.
- **Billing.** Each execution is one Durable Object request. The sandbox object is billed for wall-clock duration while an execution runs, including time spent waiting on tools.

### On the calling thread

When blocking the caller is acceptable, for example in a stateless Worker that serves one request, run the VM on the caller's thread instead. Nothing extra needs to be deployed:

```ts
import { createInlineCodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";

const sandbox = createInlineCodemodeSandbox({ tools, timeoutMs: 60_000, interruptBudget: 50_000 });
const result = await sandbox.execute(code);
```

`createInlineCodemodeSandbox()` passes the QuickJS module Wrangler compiled to `InlineCodemodeSandbox`. With another bundler, import `InlineCodemodeSandbox` from `/portable` and pass your own compiled module as `wasm`.

- **Blocking.** A script that computes blocks the caller until it awaits a tool or uses up its `interruptBudget`.
- **Stack.** QuickJS's stack guard is reduced to `INLINE_MAX_STACK_SIZE`, so that it trips before the caller's smaller stack runs out.

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
import { Type } from "typebox";

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
	parameters: Type.Object({ code: Type.String() }),
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

## Deterministic runs

`sandbox.start(code, options)` runs a script so that a host can run it again after a restart and get the same behavior, for example to resume it from a durable log of its calls' results. `execute()` is unaffected.

The VM only runs when the host hands it something, and has no timers or I/O, so it is deterministic except for what it reads from its environment. `start()` fixes that:

- **Time:** `Date.now()` reads `startedAt`, then the `now` of the result being processed, never going backwards. `performance.now()` counts from `startedAt`.
- **Randomness:** `Math.random()` and the VM's other randomness come from `seed`.
- **Timezone:** UTC, whatever the host's.
- **Garbage collection:** `WeakRef` and `FinalizationRegistry` do not exist.
- **Result order:** the host answers each call with a result number (1, 2, ...), and the VM applies results strictly in that order, whatever order a transport delivers them in.

The run declares its own tools and globals, and the host answers every call itself:

```ts
const run = sandbox.start(code, {
	startedAt: Date.now(),
	seed: 7,
	tools: [{ name: "read", description: "Read a file" }],
	onStarted: (fingerprint) => {}, // what the VM is: engine versions, prelude hash, limits
	onCall: (call) => {
		// call.id is the VM's own number for the call, in the order the script made them.
		void readFile(call.args).then((text) => run.deliver(nextResult++, Date.now(), call.id, { ok: true, value: text }));
	},
	onIdle: (seq, issued) => {}, // after result `seq` (0: the first run), `issued` calls in total
});
const result = await run.result;
```

A run has no deadline unless `timeoutMs` is given. Result numbers must run 1, 2, ... without gaps. The same script, `startedAt`, `seed`, tools (with their `jsName`), globals and store, answered with the same results in the same order, makes the same calls with the same arguments and produces the same output on any VM with the same fingerprint. To end a run with an error the script cannot catch, abort its `signal`.

## Results

`execute()` never rejects for script failures. `result.error.kind` is one of:

| kind      | meaning                                                                     |
| --------- | --------------------------------------------------------------------------- |
| `script`  | the script threw or failed to parse; `stack` points at `codemode.js:<line>` |
| `timeout` | the deadline expired or the interrupt budget ran out; VM shutdown was requested |
| `aborted` | `options.signal` fired or `close()` was called; VM shutdown was requested |
| `sandbox` | the VM or its transport failed, for example a wasm trap, a missing worker file, or a failed remote |

`result.output` holds the text and image items in the order the script produced them, also for failed executions. The host keeps all of it until the script ends, so output is limited to `MAX_OUTPUT_CHARS` (16 Mi) characters of text and base64 image data and `MAX_OUTPUT_ITEMS` (100000) items. Past either limit the script fails with a `RangeError`, even if it catches the error. `result.calls` lists every tool call with `status: "ok" | "error" | "cancelled"`. A call that is still running when the script returns (not awaited) is aborted through the tool's `signal` and reported as `cancelled`.

## How it works

This section describes `CodemodeSandbox`. The other sandboxes share the same host side, prelude, and VM, and replace only the worker thread. See [Usage on Cloudflare Workers](#usage-on-cloudflare-workers).

Each `execute()` starts a worker thread (about 20 ms including VM creation) that instantiates a fresh QuickJS VM from the compiled wasm module. The VM is a separate wasm instance with its own linear memory. Its only imports are a WASI shim (clock, random, and stdout/stderr writes, which the worker discards) and one host-call entry point, so the script cannot reach the host except through the functions the worker registers.

The worker evaluates a prelude inside the VM that holds the single host bridge in a closure and builds `tools`, `console`, and globals on top of it. The script is compiled as an async function body.

Tool calls are relayed to the host thread as messages; the host runs the tool and posts the JSON result back. The host owns the deadline and the abort signal. When either fires, it sets a shared interrupt flag that the VM polls, then calls `worker.terminate()`. The flag is needed on Bun, where `terminate()` cannot stop a thread that is spinning in wasm (`while (true) {}` or `while (true) await null`).

The worker keeps script execution off the host thread: QuickJS runs synchronously, so a spinning script on the host thread would block its event loop.

## Runtime notes

- Node and Bun support memory limits, interrupts, and a catchable `RangeError` for deep recursion (QuickJS's stack guard is enabled; without it the wasm stack overflows and traps). Bun may delay worker exit during non-interruptible built-ins; results do not wait for exit.
- Stack traces use QuickJS frames (`at f (codemode.js:2:31)`), prefixed with `Name: message` like V8. The wrapper prefix shares line 1 with the script, so line numbers are exact; column numbers on line 1 are shifted.
- QuickJS is an interpreter. Glue code and filtering tool results are fast enough; heavy computation is slower than in V8.
