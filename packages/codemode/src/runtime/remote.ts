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
 */
import { DEFAULT_CLOUDFLARE_FUEL } from "../limits.ts";
import { beginRun, type CodemodeHostCall, type CodemodeRun } from "../run.ts";
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

/**
 * The remote end, usually a Durable Object stub for `CodemodeSandboxDurableObject`. Anything with this method works,
 * for example an in-process object in tests.
 */
export interface CodemodeRemote {
	execute(request: CodemodeRemoteRequest, exchange: CodemodeRemoteExchange): Promise<void>;
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
	/** Upper bound for a request's fuel, and the budget when a request names none. Default `DEFAULT_CLOUDFLARE_FUEL`. */
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
	const requested = request.job.memoryLimitBytes;
	const maxMemory = options.maxMemoryLimitBytes;
	const memoryLimitBytes =
		requested === undefined ? maxMemory : maxMemory === undefined ? requested : Math.min(requested, maxMemory);
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
