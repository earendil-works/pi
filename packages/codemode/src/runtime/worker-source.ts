/**
 * Worker thread entry, passed to `new Worker(source, { eval: true })` so it
 * needs no file resolution under tsx, the Node bundle, or the Bun binary.
 * Evaluated as CommonJS, hence `require`.
 *
 * One worker runs one script. It creates the vm context, installs the prelude,
 * compiles the script as an async function body, and relays messages between
 * the context and the host. The host terminates the worker when the script
 * settles, times out, or is aborted.
 */
export const WORKER_SOURCE: string = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");

const { code, toolNames, globalNames, prelude } = workerData;

function post(message) {
	parentPort.postMessage(message);
}

// Called from the context with primitives only. Must return undefined so no
// worker-realm value flows back into the context.
function bridge(kind, a, b, c) {
	if (kind === "call" || kind === "global") {
		post({ type: "call", id: a, target: kind === "call" ? "tool" : "global", name: b, args: c });
	} else if (kind === "log") {
		post({ type: "log", level: a, message: b });
	} else if (kind === "done") {
		post(a ? { type: "done", ok: true, value: b } : { type: "done", ok: false, error: b });
	}
	return undefined;
}

const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, {
	codeGeneration: { strings: false, wasm: false },
});
const api = vm.runInContext(prelude, context, { filename: "codemode-prelude.js" })(
	bridge,
	JSON.stringify(toolNames),
	JSON.stringify(globalNames),
);

parentPort.on("message", (message) => {
	if (message && message.type === "result") {
		api.settle(message.id, message.ok, message.payload);
	}
});

// The prefix shares the first line with the script so reported line numbers
// match the script as written (Bun does not apply lineOffset to runtime stacks).
// tools and console are parameters so they shadow whatever the runtime puts
// on the vm global. The trailing parameters shadow globals that Bun's vm
// global refuses to delete; the prelude passes nothing for them.
let fn;
try {
	fn = new vm.Script(
		"(async (tools, console, WebAssembly, SharedArrayBuffer, Atomics) => {" + code + "\n})",
		{ filename: "codemode.js" },
	).runInContext(context);
} catch (error) {
	post({ type: "done", ok: false, error: JSON.stringify({ name: error.name, message: error.message, stack: error.stack }) });
}
if (fn) api.run(fn);
`;
