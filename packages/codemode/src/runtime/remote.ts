/**
 * Runs the VM in another isolate, reached over an RPC boundary such as a Cloudflare Durable Object stub, while tools
 * keep running in the caller.
 *
 * Problem: on Cloudflare the clock does not move while code runs, so a VM on the calling thread cannot yield on time
 * and blocks that thread while the script computes. In a Durable Object that serves an agent session, a CPU-heavy
 * script would stall every other request to the session (including the user's abort) for seconds. Measured on
 * Cloudflare (October 2026), a script that computed for 10 seconds delayed the session's other requests by 10 seconds
 * when it ran in the session object or in a Dynamic Worker, but by about 50 ms when it ran in a Durable Object of a
 * separately deployed Worker.
 *
 * Solution: the caller keeps the host role (`RemoteCodemodeSandbox`: tools, call records, deadline, abort) and the
 * remote side only runs the VM (`serveCodemodeRemote`, behind `CodemodeSandboxDurableObject` in
 * `@earendil-works/pi-codemode/cloudflare`).
 *
 * Protocol, one RPC call per execution:
 *
 *     client                                     remote
 *     remote.execute(request, exchange) ───────▶ starts the VM, with a fuel budget
 *                                      ◀─────── exchange([output?, call])    one exchange per call
 *     runs the call, replies with result ──────▶ VM continues
 *                                      ◀─────── exchange([output?, done])    terminal, reply ignored
 *     execute() resolves ◀────────────────────── VM disposed
 *
 * `exchange` is a function the client passes in; over Workers RPC it becomes a stub that calls back into the client.
 * Output made since the last exchange rides along with the next one, or goes on its own once 1,000 items or 1 MiB
 * piled up, so a script that prints in a loop does not make one RPC per line, and one that prints while it computes
 * still reaches the client. Each exchange carries at most one call, so concurrent calls are concurrent RPCs.
 *
 * Termination: the client cannot interrupt a remote VM that is computing. When the client finishes first (deadline,
 * abort, `close()`), it answers every pending and later exchange with `{ type: "stop" }`, and the remote stops the VM
 * there. A script that computes without calling a tool runs until its fuel is used up, which the remote reports as the
 * same `kind: "timeout"` failure a VM on the calling thread produces.
 *
 * Failure: if the RPC call rejects (the remote isolate crashed, hit its CPU limit, or was redeployed) or returns
 * without a terminal message, the execution fails with `kind: "sandbox"`.
 *
 * Runs the host drives (`begin()`, `resume()`) use a stateless step protocol instead, so that nothing stays alive on
 * the remote while tools run or the script is parked (a Durable Object is billed for wall-clock time while active):
 * each `advance()` is one RPC, `remote.step()`, that carries the script (its code, or its saved run), the results
 * settled since the last step, and the CPU budget. The remote starts or loads the run, applies the results, runs it
 * until it waits again or ends, saves it, disposes of its VM, and replies with the saved run and its calls, or the
 * outcome. The client's `save()` returns the last step's saved run without an RPC.
 */
import { DEFAULT_CLOUDFLARE_FUEL, DEFAULT_FUEL } from "../limits.ts";
import {
	beginRun,
	type CodemodeHostCall,
	type CodemodeRun,
	type CodemodeSaved,
	type CodemodeScope,
	resumeRun,
} from "../run.ts";
import type {
	CodemodeError,
	CodemodeOutcome,
	CodemodeOutputItem,
	CodemodeResult,
	CodemodeSandboxBaseOptions,
} from "../types.ts";
import type { CodemodeWasmModule } from "../wasm.ts";
import { CodemodeSandboxBase, drive, errorMessage, failed, type VmHost, type VmJob } from "./execution.ts";

export interface CodemodeRemoteRequest {
	job: VmJob;
	/** Requested fuel budget. The remote may lower it, see {@link CodemodeServeOptions}. */
	fuel?: number;
}

/**
 * What the remote sends to the client: output, a call, a call the script dropped, or the outcome (`done`, without the
 * output, which came before it).
 */
export type CodemodeRemoteMessage =
	| { type: "output"; items: CodemodeOutputItem[] }
	| { type: "call"; call: CodemodeHostCall }
	| { type: "dropped"; call: CodemodeHostCall }
	| { type: "done"; result: CodemodeResult };

/**
 * The client's answer to an exchange: the outcome of the call the exchange carried, `null` when it carried no call, or
 * `stop` once the client no longer wants the execution.
 */
export type CodemodeRemoteReply = { type: "result"; id: number; outcome: CodemodeOutcome } | { type: "stop" } | null;

export type CodemodeRemoteExchange = (messages: CodemodeRemoteMessage[]) => Promise<CodemodeRemoteReply>;

/** One step of a run the host drives: what the remote starts or loads, and the results settled since the last step. */
export interface CodemodeStepRequest {
	start: { kind: "begin"; code: string } | { kind: "resume"; saved: CodemodeSaved };
	scope: CodemodeScope;
	settled: { id: number; outcome: CodemodeOutcome }[];
	/** The run's CPU budget, as fuel, across its steps. The remote may lower what one step uses. */
	fuel: number;
	memoryLimitBytes: number | undefined;
}

/** What a step leaves: the run waiting on `calls`, saved, or its outcome and the calls it dropped. */
export type CodemodeStepReply =
	| { kind: "idle"; saved: CodemodeSaved; calls: CodemodeHostCall[] }
	| { kind: "done"; result: CodemodeResult; dropped: CodemodeHostCall[] };

/**
 * The remote end, usually a Durable Object stub for `CodemodeSandboxDurableObject`. Anything with these methods
 * works, for example an in-process object in tests.
 */
export interface CodemodeRemote {
	/** One `execute()`, with the client answering the script's calls through `exchange`. */
	execute(request: CodemodeRemoteRequest, exchange: CodemodeRemoteExchange): Promise<void>;
	/** One step of a run the client drives (`begin()`, `resume()`). */
	step(request: CodemodeStepRequest): Promise<CodemodeStepReply>;
}

export interface RemoteCodemodeSandboxOptions extends CodemodeSandboxBaseOptions {
	/**
	 * Returns the remote that runs one execution, called once per `execute()`. For a Durable Object, pick the instance
	 * here, for example `() => env.CODEMODE_SANDBOX.getByName(sessionId)`.
	 */
	remote: () => CodemodeRemote;
	/** Fuel budget requested from the remote. Default: the remote's default. */
	fuel?: number;
}

export interface CodemodeServeOptions {
	wasm: CodemodeWasmModule | Promise<CodemodeWasmModule>;
	/**
	 * Upper bound for the fuel of one request (an execution, or one step of a run the client drives), and the budget of
	 * an execution whose request names none. Default `DEFAULT_CLOUDFLARE_FUEL`.
	 */
	maxFuel?: number;
	/** Upper bound for a request's VM memory, and the limit when a request names none. */
	maxMemoryLimitBytes?: number;
}

/**
 * Runs each execution's VM on a remote, usually a Cloudflare Durable Object deployed with
 * `CodemodeSandboxDurableObject`, while tools run here. Same API and results as `CodemodeSandbox`'s `execute()`.
 * Differences: a script that computes without calling a tool is limited by the remote's fuel budget rather than
 * `timeoutMs`, and after a deadline or abort the remote VM keeps computing until it next calls a tool or uses up that
 * budget.
 */
export class RemoteCodemodeSandbox extends CodemodeSandboxBase {
	private readonly remote: () => CodemodeRemote;
	private readonly fuel: number | undefined;

	constructor(options: RemoteCodemodeSandboxOptions) {
		super(options);
		this.remote = options.remote;
		this.fuel = options.fuel;
	}

	/** A run whose steps run on the remote, one RPC each; nothing stays there between them. */
	async begin(code: string, scope: CodemodeScope): Promise<CodemodeRun> {
		return new RemoteRun(this.stepper(scope), { kind: "begin", code });
	}

	/** Continues a saved run: one step on the remote loads it, to learn the calls it waits on. */
	async resume(scope: CodemodeScope, saved: CodemodeSaved): Promise<CodemodeRun> {
		const run = new RemoteRun(this.stepper(scope), { kind: "idle", saved, calls: [] });
		await run.advance();
		return run;
	}

	/** One step of a run with `scope`, on the remote `remote()` picks. */
	private stepper(scope: CodemodeScope): Stepper {
		return (start, settled) =>
			this.remote().step({
				start,
				scope,
				settled,
				fuel: this.fuel ?? DEFAULT_FUEL,
				memoryLimitBytes: this.memoryLimitBytes,
			});
	}

	/** Runs the VM on the remote `remote()` picks, answering its calls here. */
	protected runVm(job: VmJob, host: VmHost): Promise<CodemodeResult> {
		return new Promise<CodemodeResult>((resolve) => {
			const output: CodemodeOutputItem[] = [];
			let settled = false;
			const waiting = new Set<(reply: CodemodeRemoteReply) => void>();
			const finish = (result: CodemodeResult) => {
				if (settled) return;
				settled = true;
				for (const reply of waiting) reply({ type: "stop" });
				waiting.clear();
				resolve(result);
			};
			host.signal.addEventListener("abort", () => finish(failed(host.signal.reason as CodemodeError, output)), {
				once: true,
			});
			const exchange: CodemodeRemoteExchange = (messages) =>
				new Promise<CodemodeRemoteReply>((reply) => {
					// Wire input: the remote's messages, as Workers RPC delivered them.
					if (settled || !Array.isArray(messages)) {
						reply({ type: "stop" });
						return;
					}
					let call: CodemodeHostCall | undefined;
					for (const message of messages) {
						if (message.type === "output") output.push(...message.items);
						else if (message.type === "call") call = message.call;
						else if (message.type === "dropped") host.dropped(message.call);
						else if (message.type === "done") finish({ ...message.result, output });
					}
					if (call === undefined || settled) {
						reply(settled ? { type: "stop" } : null);
						return;
					}
					const id = call.id;
					waiting.add(reply);
					void host.call(call).then((outcome) => {
						if (waiting.delete(reply)) reply({ type: "result", id, outcome });
					});
				});
			const request: CodemodeRemoteRequest = this.fuel === undefined ? { job } : { job, fuel: this.fuel };
			Promise.resolve()
				.then(() => this.remote().execute(request, exchange))
				.then(
					() =>
						finish(
							failed({ kind: "sandbox", message: "Remote sandbox returned before the script settled" }, output),
						),
					(error: unknown) =>
						finish(failed({ kind: "sandbox", message: `Remote sandbox failed: ${errorMessage(error)}` }, output)),
				);
		});
	}
}

/** Output buffered on the remote before it is sent without waiting for a call. */
const FLUSH_ITEMS = 1_000;
const FLUSH_CHARS = 1 << 20;

/**
 * Remote side of {@link RemoteCodemodeSandbox}: runs one execution's VM on this thread and forwards its calls and
 * output through `exchange`. Resolves once the VM has stopped and the terminal message has been delivered, or the
 * client asked to stop. Never rejects.
 */
export async function serveCodemodeRemote(
	request: CodemodeRemoteRequest,
	exchange: CodemodeRemoteExchange,
	options: CodemodeServeOptions,
): Promise<void> {
	const maxFuel = options.maxFuel ?? DEFAULT_CLOUDFLARE_FUEL;
	const memoryLimitBytes = capped(request.job.memoryLimitBytes, options.maxMemoryLimitBytes);
	const stop = new AbortController();
	const stopped = (reply: CodemodeRemoteReply) => {
		if (reply?.type === "stop") stop.abort({ kind: "aborted", message: "The client stopped the execution" });
	};
	let buffered: CodemodeOutputItem[] = [];
	let bufferedChars = 0;
	const dropped: CodemodeRemoteMessage[] = [];
	const unsent = (): CodemodeRemoteMessage[] => {
		const items = buffered;
		buffered = [];
		bufferedChars = 0;
		return [...(items.length === 0 ? [] : [{ type: "output", items } as const]), ...dropped.splice(0)];
	};
	// A script that prints while it computes sends its output on, so that the client has it and `done` stays small.
	const observe = (item: CodemodeOutputItem) => {
		buffered.push(item);
		bufferedChars += item.type === "text" ? item.text.length : item.data.length;
		if (buffered.length >= FLUSH_ITEMS || bufferedChars >= FLUSH_CHARS) {
			exchange(unsent()).then(stopped, () => stopped({ type: "stop" }));
		}
	};
	let vm: CodemodeRun | undefined;
	let result: CodemodeResult;
	try {
		const engine = {
			module: await options.wasm,
			fuel: Math.min(request.fuel ?? maxFuel, maxFuel),
			...(memoryLimitBytes === undefined ? {} : { memoryLimitBytes }),
		};
		vm = beginRun(engine, request.job.code, request.job.scope, observe);
		const host: VmHost = {
			signal: stop.signal,
			call: async (call) => {
				const reply = await exchange([...unsent(), { type: "call", call }]).catch(
					() => ({ type: "stop" }) as const,
				);
				if (reply?.type === "result") return reply.outcome;
				stopped({ type: "stop" });
				return { ok: false, message: "The client stopped the execution" };
			},
			dropped: (call) => void dropped.push({ type: "dropped", call }),
		};
		result = await drive(vm, host);
	} catch (error) {
		result = failed({ kind: "sandbox", message: errorMessage(error) }, []);
	} finally {
		vm?.dispose();
	}
	if (!stop.signal.aborted) {
		await exchange([...unsent(), { type: "done", result: { ...result, output: [] } }]).catch(() => null);
	}
}

/**
 * Remote side of a step of a run the client drives (see {@link CodemodeStepRequest}): starts or loads the run here,
 * applies the settled results, runs it until it waits again or ends, and saves it. Keeps nothing.
 */
export async function serveCodemodeStep(
	request: CodemodeStepRequest,
	options: CodemodeServeOptions,
): Promise<CodemodeStepReply> {
	const { start, scope } = request;
	const used = start.kind === "resume" ? start.saved.fuelUsed : 0;
	const memoryLimitBytes = capped(request.memoryLimitBytes, options.maxMemoryLimitBytes);
	const engine = {
		module: await options.wasm,
		// The run's budget, but no more than one request may use here.
		fuel: Math.min(request.fuel, used + (options.maxFuel ?? DEFAULT_CLOUDFLARE_FUEL)),
		...(memoryLimitBytes === undefined ? {} : { memoryLimitBytes }),
	};
	const run = start.kind === "begin" ? beginRun(engine, start.code, scope) : resumeRun(engine, scope, start.saved);
	try {
		for (const { id, outcome } of request.settled) run.settle(id, outcome);
		await run.advance();
		if (run.result !== undefined) return { kind: "done", result: run.result, dropped: [...run.dropped] };
		let saved: CodemodeSaved;
		try {
			saved = run.save();
		} catch (error) {
			const message = `The script holds a value a saved run cannot keep, which a remote sandbox needs between steps: ${errorMessage(error)}`;
			return { kind: "done", result: failed({ kind: "sandbox", message }, run.output), dropped: [...run.calls] };
		}
		return { kind: "idle", saved, calls: [...run.calls] };
	} finally {
		run.dispose();
	}
}

/** A requested limit, lowered to the remote's. */
function capped(requested: number | undefined, max: number | undefined): number | undefined {
	return requested === undefined ? max : max === undefined ? requested : Math.min(requested, max);
}

/** Runs one step on the remote: from `start`, with `settled` applied. */
type Stepper = (
	start: CodemodeStepRequest["start"],
	settled: CodemodeStepRequest["settled"],
) => Promise<CodemodeStepReply>;

/** Where a remote run is: not started yet, waiting on calls (saved), or ended. */
type RemoteState =
	| { kind: "begin"; code: string }
	| { kind: "idle"; saved: CodemodeSaved; calls: readonly CodemodeHostCall[] }
	| { kind: "done"; result: CodemodeResult; dropped: readonly CodemodeHostCall[] };

/** A run the client drives whose steps run on a remote: its state is the last step's saved run. */
class RemoteRun implements CodemodeRun {
	private state: RemoteState;
	private readonly step: Stepper;
	private settled: CodemodeStepRequest["settled"] = [];

	constructor(step: Stepper, state: RemoteState) {
		this.step = step;
		this.state = state;
	}

	get calls(): readonly CodemodeHostCall[] {
		return this.state.kind === "idle" ? this.state.calls : [];
	}

	get result(): CodemodeResult | undefined {
		return this.state.kind === "done" ? this.state.result : undefined;
	}

	get output(): readonly CodemodeOutputItem[] {
		if (this.state.kind === "idle") return this.state.saved.output;
		return this.state.kind === "done" ? this.state.result.output : [];
	}

	get dropped(): readonly CodemodeHostCall[] {
		return this.state.kind === "done" ? this.state.dropped : [];
	}

	settle(id: number, outcome: CodemodeOutcome): void {
		if (this.state.kind === "idle") this.settled.push({ id, outcome });
	}

	/** One step on the remote. A step in flight cannot be stopped: its fuel bounds it; `signal` stops the next. */
	async advance(signal?: AbortSignal): Promise<void> {
		if (this.state.kind === "done") return;
		signal?.throwIfAborted();
		const start: CodemodeStepRequest["start"] =
			this.state.kind === "begin" ? this.state : { kind: "resume", saved: this.state.saved };
		const settled = this.settled;
		this.settled = [];
		try {
			const reply = await this.step(start, settled);
			this.state = reply;
		} catch (error) {
			const message = `Remote sandbox failed: ${errorMessage(error)}`;
			this.state = { kind: "done", result: failed({ kind: "sandbox", message }, this.output), dropped: [] };
		}
		signal?.throwIfAborted();
	}

	save(): CodemodeSaved {
		if (this.state.kind !== "idle") throw new Error("The script has not started or has ended");
		return this.state.saved;
	}

	dispose(): void {}
}
