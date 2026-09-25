# @earendil-works/pi-codemode

Runs model-written JavaScript in a QuickJS VM (compiled to WebAssembly) where the only capability is calling injected tools. Nested tool calls never enter the LLM context; only the script's return value and logs do.

The coding agent uses it for its built-in `codemode` tool. It has no pi dependencies and can be used on its own to expose any functions (remote APIs, MCP servers, application services) to model-written scripts.

## Usage

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
	const text = await tools.read({ path: "package.json" });
	console.log("bytes", text.length);
	return JSON.parse(text).name;
`);

if (result.ok) console.log(result.value); // "@earendil-works/pi-codemode"
else console.error(result.error.kind, result.error.message);

await sandbox.close();
```

`code` is the body of an async function: `return` and top-level `await` work. Inside the script:

- `tools.<name>(args)` returns a promise. Arguments and results make a JSON round trip. A tool that throws rejects with an `Error` carrying the same message.
- `console.log/info/warn/error/debug` are captured into `result.logs`.
- `globals` passed to the sandbox are called as top-level functions, for example a host helper `image(ref)`. They behave like tools but are not recorded in `result.calls`.
- `store(key, value)` and `load(key)` read and write JSON values synchronously. See [Store](#store).
- Nothing else: no timers, `fetch`, `process`, `require`, modules, or `WebAssembly`. `eval` and `Function` work but only produce more code inside the same VM.

`timeoutMs: Infinity` disables the deadline; the script then runs until it settles or `signal` aborts it.

`memoryLimitBytes` caps the VM's heap. Allocations beyond it fail inside the script as `InternalError: out of memory`.

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

`parseCodemodeSource()` accepts a script whose first line may set options:

```js
// @options {"timeout": 30}
const text = await tools.read({ path: "package.json" });
return JSON.parse(text).name;
```

The only option is `timeout` (seconds). The options line is replaced by an empty line, so line numbers in stack traces still match the input. Invalid JSON, unknown keys, or an options line without code throw `CodemodeSourceError`. `CODEMODE_SOURCE_GRAMMAR` is the matching Lark grammar for providers that support grammar-constrained tool input. Both are also available from the lightweight `@earendil-works/pi-codemode/source` entry.

## Bundled hosts

By default the sandbox loads `quickjs-wasi/quickjs.wasm` from the installed package and starts the worker file that sits next to this package's module. Neither exists on disk when the host is bundled, so pass both:

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

Schemas only shape the declarations; values are not validated against them.

`execute()` never rejects for script failures. `result.error.kind` is one of:

| kind      | meaning                                                                     |
| --------- | --------------------------------------------------------------------------- |
| `script`  | the script threw or failed to parse; `stack` points at `codemode.js:<line>` |
| `timeout` | the deadline expired; the worker was terminated                             |
| `aborted` | `options.signal` fired or `close()` was called; the worker was terminated   |
| `sandbox` | the worker or VM failed, for example a wasm trap or a missing worker file   |

`result.calls` lists every tool call with `status: "ok" | "error" | "cancelled"`. A call that is still running when the script returns (not awaited) is aborted through the tool's `signal` and reported as `cancelled`.

## How it works

Each `execute()` starts a worker thread (about 20 ms including VM creation) that instantiates a fresh QuickJS VM from the compiled wasm module. The VM is a separate wasm instance with its own linear memory. Its only imports are a WASI shim (clock, random, and stdout/stderr writes, which the worker discards) and one host-call entry point, so the script cannot reach the host except through the functions the worker registers.

The worker evaluates a prelude inside the VM that holds the single host bridge in a closure and builds `tools`, `console`, and globals on top of it. The script is compiled as an async function body.

Tool calls are relayed to the host thread as messages; the host runs the tool and posts the JSON result back. The host owns the deadline and the abort signal. When either fires, it sets a shared interrupt flag that the VM polls, then calls `worker.terminate()`. The flag is needed on Bun, where `terminate()` cannot stop a thread that is spinning in wasm (`while (true) {}` or `while (true) await null`).

The worker keeps script execution off the host thread: QuickJS runs synchronously, so a spinning script on the host thread would block its event loop.

## Runtime notes

- Works the same on Node and Bun, including memory limits, interrupts, and a catchable `RangeError` for deep recursion (QuickJS's stack guard is enabled; without it the wasm stack overflows and traps).
- Stack traces use QuickJS frames (`at f (codemode.js:2:31)`), prefixed with `Name: message` like V8. The wrapper prefix shares line 1 with the script, so line numbers are exact; column numbers on line 1 are shifted.
- QuickJS is an interpreter. Glue code and filtering tool results are fast enough; heavy computation is slower than in V8.
