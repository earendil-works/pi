/**
 * Cloudflare Workers entry, for Workers built with Wrangler.
 *
 * Wrangler's default `CompiledWasm` rule turns the `.wasm` import below into a
 * `WebAssembly.Module`; Workers cannot compile WebAssembly from bytes at runtime. Other bundlers
 * do not support the import: use `@earendil-works/pi-codemode/portable` with your own module there.
 *
 * Two ways to run codemode on Cloudflare:
 * - `RemoteCodemodeSandbox` with a {@link CodemodeSandboxDurableObject} deployed as its own
 *   Worker: scripts run in a separate isolate and never block the caller. Use this from a Durable
 *   Object that serves a session.
 * - {@link createInlineCodemodeSandbox}: scripts run on the caller's thread. Simplest; a script
 *   that computes blocks the caller until it awaits a tool or uses up its interrupt budget.
 */
import { DurableObject } from "cloudflare:workers";
import quickjsWasmImport from "quickjs-wasi/quickjs.wasm";
import {
	DEFAULT_INTERRUPT_BUDGET,
	InlineCodemodeSandbox,
	type InlineCodemodeSandboxOptions,
} from "./runtime/inline.ts";
import { type CodemodeRemoteExchange, type CodemodeRemoteRequest, serveCodemodeRemote } from "./runtime/remote.ts";
import type { CodemodeWasmModule } from "./wasm.ts";

export * from "./portable.ts";

// Wrangler's `CompiledWasm` rule makes this a compiled module; the declaration cannot say so (see
// cloudflare-modules.d.ts).
const quickjsWasm = quickjsWasmImport as unknown as CodemodeWasmModule;

/** Default VM memory limit of {@link CodemodeSandboxDurableObject}. Isolates have 128 MB in total. */
export const DEFAULT_REMOTE_MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;

/** `quickjs-wasi/quickjs.wasm`, compiled by Wrangler. */
export const cloudflareQuickJSWasm: CodemodeWasmModule = quickjsWasm;

/** `InlineCodemodeSandbox` with the QuickJS module Wrangler bundled. */
export function createInlineCodemodeSandbox(options: Omit<InlineCodemodeSandboxOptions, "wasm"> = {}) {
	return new InlineCodemodeSandbox({ ...options, wasm: quickjsWasm });
}

/**
 * The remote end of `RemoteCodemodeSandbox`: a Durable Object whose one RPC method runs a script's
 * VM and calls back into the client for every tool call.
 *
 * Deploy it as its own Worker and bind it from the Worker that runs your agent with `script_name`.
 * A separate Worker is what keeps scripts off the agent's thread: a class in the same Worker can
 * share an isolate, and therefore a thread, with the objects that call it.
 *
 * The object keeps no state between executions and never touches storage. Executions that reach
 * the same instance share its thread: they interleave while they wait on tools, and a script that
 * computes delays the others. Name instances per session (`getByName(sessionId)`) to keep one
 * session's scripts together, or per execution for full independence.
 *
 * Limits apply to every request, whatever the client asks for. Override the fields in a subclass:
 *
 *     export class CodemodeSandbox extends CodemodeSandboxDurableObject {
 *       protected maxInterruptBudget = 200_000;
 *     }
 */
export class CodemodeSandboxDurableObject<Env = unknown> extends DurableObject<Env> {
	/** Interrupt polls per execution; the client may only ask for less. See `InlineCodemodeSandboxOptions`. */
	protected maxInterruptBudget: number = DEFAULT_INTERRUPT_BUDGET;
	/** VM memory per execution; the client may only ask for less. */
	protected maxMemoryLimitBytes: number = DEFAULT_REMOTE_MEMORY_LIMIT_BYTES;

	/** Called by `RemoteCodemodeSandbox` over RPC. Resolves when the script has settled or was stopped. */
	execute(request: CodemodeRemoteRequest, exchange: CodemodeRemoteExchange): Promise<void> {
		return serveCodemodeRemote(request, exchange, {
			wasm: quickjsWasm,
			maxInterruptBudget: this.maxInterruptBudget,
			maxMemoryLimitBytes: this.maxMemoryLimitBytes,
		});
	}
}
