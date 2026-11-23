/**
 * Runs each script's djs VM on the calling thread. Works in any runtime with WebAssembly: a step of the script yields
 * to the event loop every few milliseconds while it computes, so the host's timers, I/O, the deadline, and an abort
 * keep working while `while (true) {}` runs.
 *
 * Where the clock does not move while code runs (Cloudflare Workers and Durable Objects), a step cannot yield on time
 * and a script that computes blocks the caller until it calls a tool: give it a `fuel` budget there, and use
 * `RemoteCodemodeSandbox` to keep scripts off a thread that must stay responsive.
 */
import {
	beginRun,
	type CodemodeRun,
	type CodemodeSaved,
	type CodemodeScope,
	type RunEngine,
	resumeRun,
} from "../run.ts";
import type { CodemodeSandboxOptions } from "../types.ts";
import { loadDjsWasm } from "../wasm.ts";
import { CodemodeSandboxBase, drive, errorMessage, failed } from "./execution.ts";

/**
 * Runs JavaScript and TypeScript in a djs VM (a separate wasm instance) on the calling thread: `execute()` runs a
 * script with the sandbox's tools and globals; `begin()` and `resume()` give the host a run to drive itself, which it
 * can save while the script waits and continue later, in another process.
 */
export class CodemodeSandbox extends CodemodeSandboxBase {
	private readonly engine: () => Promise<RunEngine>;

	constructor(options: CodemodeSandboxOptions = {}) {
		const wasm = options.wasm ?? loadDjsWasm();
		const engine = async (memoryLimitBytes: number | undefined): Promise<RunEngine> => ({
			module: await wasm,
			...(memoryLimitBytes === undefined ? {} : { memoryLimitBytes }),
			...(options.fuel === undefined ? {} : { fuel: options.fuel }),
			...(options.stepFuel === undefined ? {} : { stepFuel: options.stepFuel }),
		});
		super(options, async (job, host) => {
			let run: CodemodeRun;
			try {
				run = beginRun(await engine(job.memoryLimitBytes), job.code, job.scope);
			} catch (error) {
				return failed({ kind: "sandbox", message: `Failed to start the VM: ${errorMessage(error)}` }, []);
			}
			try {
				return await drive(run, host);
			} finally {
				run.dispose();
			}
		});
		this.engine = () => engine(options.memoryLimitBytes);
	}

	/**
	 * A new run of `code` (an async function body, JavaScript or TypeScript) that reaches what `scope` declares, not
	 * the sandbox's tools and globals: its calls go to the caller, which answers them with `run.settle()`. `advance()`
	 * runs it to its first idle point.
	 */
	async begin(code: string, scope: CodemodeScope): Promise<CodemodeRun> {
		return beginRun(await this.engine(), code, scope);
	}

	/** Continues a run `run.save()` wrote, in a new VM. `scope` must give every identity the run refers to. */
	async resume(scope: CodemodeScope, saved: CodemodeSaved): Promise<CodemodeRun> {
		return resumeRun(await this.engine(), scope, saved);
	}
}
