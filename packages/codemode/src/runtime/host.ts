/**
 * Runs each script's djs VM on the calling thread. Works in any runtime with WebAssembly: a step of the script yields
 * to the event loop every few milliseconds while it computes, so the host's timers, I/O, the deadline, and an abort
 * keep working while `while (true) {}` runs.
 *
 * Where the clock does not move while code runs (Cloudflare Workers and Durable Objects), a step cannot yield on time
 * and a script that computes blocks the caller until it calls a tool: give it a `fuel` budget there, and use
 * `RemoteCodemodeSandbox` to keep scripts off a thread that must stay responsive.
 */

import { DEFAULT_FUEL } from "../limits.ts";
import {
	beginRun,
	type CodemodeRun,
	type CodemodeSaved,
	type CodemodeScope,
	type RunEngine,
	resumeRun,
} from "../run.ts";
import type { CodemodeResult, CodemodeSandboxOptions } from "../types.ts";
import { loadCodemodeWasm } from "../wasm.ts";
import { CodemodeSandboxBase, drive, errorMessage, failed, type VmHost, type VmJob } from "./execution.ts";

/**
 * Runs JavaScript and TypeScript in a djs VM (a separate wasm instance) on the calling thread: `execute()` runs a
 * script with the sandbox's tools and globals; `begin()` and `resume()` give the host a run to drive itself, which it
 * can save while the script waits and continue later, in another process.
 */
export class CodemodeSandbox extends CodemodeSandboxBase {
	private readonly options: CodemodeSandboxOptions;

	constructor(options: CodemodeSandboxOptions = {}) {
		super(options);
		this.options = options;
	}

	async begin(code: string, scope: CodemodeScope): Promise<CodemodeRun> {
		return beginRun(await this.engine(), code, scope);
	}

	async resume(scope: CodemodeScope, saved: CodemodeSaved): Promise<CodemodeRun> {
		return resumeRun(await this.engine(), scope, saved);
	}

	protected async runVm(job: VmJob, host: VmHost): Promise<CodemodeResult> {
		let run: CodemodeRun;
		try {
			run = await this.begin(job.code, job.scope);
		} catch (error) {
			return failed({ kind: "sandbox", message: `Failed to start the VM: ${errorMessage(error)}` }, []);
		}
		try {
			return await drive(run, host);
		} finally {
			run.dispose();
		}
	}

	/** The module, loaded on first use, and the limits. */
	private async engine(): Promise<RunEngine> {
		const { wasm, fuel } = this.options;
		return {
			module: await (wasm ?? loadCodemodeWasm()),
			fuel: fuel ?? DEFAULT_FUEL,
			...(this.memoryLimitBytes === undefined ? {} : { memoryLimitBytes: this.memoryLimitBytes }),
		};
	}
}
