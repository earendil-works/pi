/**
 * Runs each execution's djs VM on the calling thread. Works in any runtime with WebAssembly: a step of the script
 * yields to the event loop every few milliseconds while it computes, so the host's timers, I/O, the deadline, and an
 * abort keep working while `while (true) {}` runs.
 *
 * Where the clock does not move while code runs (Cloudflare Workers and Durable Objects), a step cannot yield on time
 * and a script that computes blocks the caller until it calls a tool: give it a `fuel` budget there, and use
 * `RemoteCodemodeSandbox` to keep scripts off a thread that must stay responsive.
 */
import { type CodemodeVm, DjsCodemode } from "../djs.ts";
import type { CodemodeSandboxOptions } from "../types.ts";
import { type CodemodeWasmModule, loadDjsWasm } from "../wasm.ts";
import { CodemodeSandboxBase, drive, errorMessage, failed, type VmRunner } from "./execution.ts";

/** Runs JavaScript and TypeScript in a djs VM (a separate wasm instance) on the calling thread. */
export class CodemodeSandbox extends CodemodeSandboxBase {
	constructor(options: CodemodeSandboxOptions = {}) {
		super(options, localRunner(options.wasm ?? loadDjsWasm(), options.fuel));
	}
}

/** Runs each VM here, on `wasm`, with `fuel` per execution. */
export function localRunner(
	wasm: CodemodeWasmModule | Promise<CodemodeWasmModule>,
	fuel: number | undefined,
): VmRunner {
	return async (job, host) => {
		let module: CodemodeWasmModule;
		try {
			module = await wasm;
		} catch (error) {
			return failed({ kind: "sandbox", message: `Failed to load djs: ${errorMessage(error)}` }, []);
		}
		const engine = new DjsCodemode({
			module,
			...(job.memoryLimitBytes === undefined ? {} : { memoryLimitBytes: job.memoryLimitBytes }),
			...(fuel === undefined ? {} : { fuel }),
		});
		let vm: CodemodeVm;
		try {
			vm = engine.begin(job.code, job.scope);
		} catch (error) {
			return failed({ kind: "sandbox", message: errorMessage(error) }, []);
		}
		try {
			return await drive(vm, host);
		} finally {
			vm.dispose();
		}
	};
}
