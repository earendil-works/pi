/**
 * Cloudflare Workers entry, for Workers built with Wrangler.
 *
 * Wrangler's default `CompiledWasm` rule turns the `.wasm` import below into a `WebAssembly.Module`; Workers cannot
 * compile WebAssembly from bytes at runtime. Other bundlers do not support the import: use
 * `@earendil-works/pi-codemode/portable` with your own module there.
 *
 * Two ways to run code mode on Cloudflare:
 * - `RemoteCodemodeSandbox` with a {@link CodemodeSandboxDurableObject} deployed as its own Worker: scripts run in a
 *   separate isolate and never block the caller. Use this from a Durable Object that serves a session.
 * - {@link createCodemodeSandbox}: scripts run on the caller's thread. Simplest; a script that computes blocks the
 *   caller until it awaits a tool or uses up its fuel.
 */
import { DurableObject } from "cloudflare:workers";
// One of the literal locations of the djs module (with wasm.ts): Wrangler needs the specifier as written.
import wasmImport from "@earendil-works/djs/wasm/djs.wasm";
import { DEFAULT_CLOUDFLARE_FUEL } from "./limits.ts";
import { CodemodeSandbox } from "./runtime/host.ts";
import { type CodemodeRemoteExchange, type CodemodeRemoteRequest, serveCodemodeRemote } from "./runtime/remote.ts";
import type { CodemodeSandboxOptions } from "./types.ts";
import type { CodemodeWasmModule } from "./wasm.ts";

export * from "./portable.ts";

/**
 * The module, compiled by Wrangler. Its `CompiledWasm` rule makes the import a compiled module; the declaration
 * cannot say so (see cloudflare-modules.d.ts).
 */
export const cloudflareCodemodeWasm = wasmImport as unknown as CodemodeWasmModule;

/** Default VM memory limit of {@link CodemodeSandboxDurableObject}. Isolates have 128 MB in total. */
export const DEFAULT_REMOTE_MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;

/** `CodemodeSandbox` on the module Wrangler bundled, with the CPU budget of `DEFAULT_CLOUDFLARE_FUEL` unless given. */
export function createCodemodeSandbox(options: Omit<CodemodeSandboxOptions, "wasm"> = {}): CodemodeSandbox {
	return new CodemodeSandbox({ fuel: DEFAULT_CLOUDFLARE_FUEL, ...options, wasm: cloudflareCodemodeWasm });
}

/**
 * The remote end of `RemoteCodemodeSandbox`: a Durable Object whose one RPC method runs a script's VM and calls back
 * into the client for every tool call.
 *
 * Deploy it as its own Worker and bind it from the Worker that runs your agent with `script_name`. A separate Worker
 * is what keeps scripts off the agent's thread: a class in the same Worker can share an isolate, and therefore a
 * thread, with the objects that call it.
 *
 * The object keeps no state between executions and never touches storage. Executions that reach the same instance
 * share its thread: they interleave while they wait on tools, and a script that computes delays the others. Name
 * instances per session (`getByName(sessionId)`) to keep one session's scripts together, or per execution for full
 * independence.
 *
 * Limits apply to every request, whatever the client asks for. Override the fields in a subclass:
 *
 *     export class CodemodeSandbox extends CodemodeSandboxDurableObject {
 *       protected maxFuel = 2_000_000_000;
 *     }
 */
export class CodemodeSandboxDurableObject<Env = unknown> extends DurableObject<Env> {
	/** Fuel per execution; the client may only ask for less. */
	protected maxFuel: number = DEFAULT_CLOUDFLARE_FUEL;
	/** VM memory per execution; the client may only ask for less. */
	protected maxMemoryLimitBytes: number = DEFAULT_REMOTE_MEMORY_LIMIT_BYTES;

	/** Called by `RemoteCodemodeSandbox` over RPC. Resolves when the script has settled or was stopped. */
	execute(request: CodemodeRemoteRequest, exchange: CodemodeRemoteExchange): Promise<void> {
		return serveCodemodeRemote(request, exchange, {
			wasm: cloudflareCodemodeWasm,
			maxFuel: this.maxFuel,
			maxMemoryLimitBytes: this.maxMemoryLimitBytes,
		});
	}
}
