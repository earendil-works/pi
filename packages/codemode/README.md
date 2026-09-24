# @earendil-works/pi-codemode

Runs model-written JavaScript in a locked-down sandbox where the only capability is calling injected tools. Nested tool calls never enter the LLM context; only the script's return value and logs do.

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
- Nothing else: no timers, `fetch`, `process`, `require`, `import()`, `eval`, `Function`, or `WebAssembly`.

`timeoutMs: Infinity` disables the deadline; the script then runs until it settles or `signal` aborts it.

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
| `sandbox` | the worker died on its own, for example out of memory                       |

`result.calls` lists every tool call with `status: "ok" | "error" | "cancelled"`. A call that is still running when the script returns (not awaited) is aborted through the tool's `signal` and reported as `cancelled`.

## How it works

Each `execute()` starts a worker thread from an inline source string (no file resolution, so it works under tsx, the Node bundle, and the Bun binary; about 10 ms). The worker creates a `node:vm` context with `DONT_CONTEXTIFY` and code generation from strings and wasm disabled, evaluates a prelude inside it, and compiles the script as an async function body.

The prelude is the only code that holds the bridge function to the worker realm. It calls the bridge with primitives only and builds everything the script can touch (`tools`, `console`, promises, errors) inside the context. This matters because a worker-realm function leaked into the context escapes through `fn.constructor("return process")()`, which the context's code-generation ban does not cover.

Tool calls are relayed to the host thread as messages; the host runs the tool and posts the JSON result back. The host owns the deadline and the abort signal and enforces both with `worker.terminate()`, which also stops scripts that only spin the microtask queue (`while (true) await null`), something `vm`'s own `timeout` option cannot do.

`node:vm` is not a security boundary against a hostile script author. The goal is that every capability goes through a registered tool, so tool-level hooks and permissions still apply.

## Runtime notes

- Bun's vm global lazily re-creates `console`, `WebAssembly`, `SharedArrayBuffer`, and `Atomics`, so deleting or redefining them has no effect there. The script wrapper binds these names as parameters instead, which shadows the globals on both runtimes. Wasm compilation is blocked by the embedder flag either way; the built-in vm `console` is a no-op on both runtimes.
- `maxOldGenerationSizeMb` is enforced on Node (`ERR_WORKER_OUT_OF_MEMORY` surfaces as `kind: "sandbox"`). Bun ignores it; rely on `timeoutMs`.
- Bun does not apply `lineOffset` to runtime stack traces, so the wrapper prefix shares line 1 with the script instead. Column numbers on line 1 are shifted; line numbers are exact.
