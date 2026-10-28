/**
 * Runs the VM in another isolate, reached over an RPC boundary such as a Cloudflare Durable Object
 * stub, while tools keep running in the caller.
 *
 * Problem: a VM on the calling thread blocks that thread while the script computes. In a Durable
 * Object that serves an agent session, a CPU-heavy script would stall every other request to the
 * session (including the user's abort) for seconds. Measured on Cloudflare (October 2026), a
 * script that computed for 10 seconds delayed the session's other requests by 10 seconds when it
 * ran in the session object or in a Dynamic Worker, but by about 50 ms when it ran in a Durable
 * Object of a separately deployed Worker.
 *
 * Solution: the caller keeps the host role (`RemoteCodemodeSandbox`: tools, call records,
 * deadline, abort) and the remote side only runs the VM (`serveCodemodeRemote`, behind
 * `CodemodeSandboxDurableObject` in `@earendil-works/pi-codemode/cloudflare`).
 *
 * Protocol, one RPC call per execution:
 *
 *     client                                     remote
 *     remote.execute(request, exchange) ───────▶ starts the VM (in-thread, with interrupt budget)
 *                                      ◀─────── exchange([...outputs, call])   one call per tool call
 *     runs the tool, replies with result ──────▶ VM continues
 *                                      ◀─────── exchange([...outputs, done])   terminal, reply ignored
 *     execute() resolves ◀────────────────────── VM disposed
 *
 * `exchange` is a function the client passes in; over Workers RPC it becomes a stub that calls back
 * into the client. Output is buffered on the remote side and sent with the next call or the
 * terminal message, so a script that prints in a loop does not make one RPC per line. Each
 * `exchange` carries at most one call, so concurrent tool calls are concurrent RPCs. Calls on one
 * stub are delivered in order, which keeps output ordered before the call or result that follows.
 *
 * Termination: the client cannot interrupt a remote VM that is computing. When the client finishes
 * first (deadline, abort, `close()`), it answers every pending and later `exchange` with
 * `{ type: "stop" }`, and the remote stops the VM at that point. A script that computes without
 * calling a tool runs until its interrupt budget is used up. The remote reports that as a
 * `failure` message, which the client turns into the same `kind: "timeout"` error an in-thread
 * VM produces.
 *
 * Failure: if the RPC call rejects (the remote isolate crashed, hit its CPU limit, or was
 * redeployed) or returns without a terminal message, the execution fails with `kind: "sandbox"`.
 */
import type { CodemodeError, CodemodeSandboxBaseOptions } from "../types.ts";
import type { CodemodeWasmModule } from "../wasm.ts";
import { CodemodeSandboxBase, errorMessage, type VmChannel, type VmLauncher } from "./execution.ts";
import { DEFAULT_INTERRUPT_BUDGET, inlineLauncher } from "./inline.ts";
import {
	type HostToWorkerMessage,
	isWorkerToHostMessage,
	type VmStartData,
	type WorkerToHostMessage,
} from "./protocol.ts";

export interface CodemodeRemoteRequest {
	data: VmStartData;
	/** Requested interrupt budget. The remote may lower it, see {@link CodemodeServeOptions}. */
	interruptBudget?: number;
}

/** What the remote sends to the client: VM messages, or a failure outside the VM bridge. */
export type CodemodeRemoteMessage = WorkerToHostMessage | { type: "failure"; error: CodemodeError };

/**
 * The client's answer to an exchange: the result of the call the exchange carried, `null` when it
 * carried no call, or `stop` once the client no longer wants the execution.
 */
export type CodemodeRemoteReply = HostToWorkerMessage | { type: "stop" } | null;

export type CodemodeRemoteExchange = (messages: CodemodeRemoteMessage[]) => Promise<CodemodeRemoteReply>;

/**
 * The remote end, usually a Durable Object stub for `CodemodeSandboxDurableObject`. Anything with
 * this method works, for example an in-process object in tests.
 */
export interface CodemodeRemote {
	execute(request: CodemodeRemoteRequest, exchange: CodemodeRemoteExchange): Promise<void>;
}

export interface RemoteCodemodeSandboxOptions extends CodemodeSandboxBaseOptions {
	/**
	 * Returns the remote that runs one execution, called once per `execute()`. For a Durable Object,
	 * pick the instance here, for example `() => env.CODEMODE_SANDBOX.getByName(sessionId)`.
	 */
	remote: () => CodemodeRemote;
	/** Interrupt budget requested from the remote. Default: the remote's default. */
	interruptBudget?: number;
}

/** Output buffered on the remote before it is flushed without waiting for a call. */
const FLUSH_ITEMS = 1_000;
const FLUSH_CHARS = 1 << 20;

export interface CodemodeServeOptions {
	wasm: CodemodeWasmModule | Promise<CodemodeWasmModule>;
	/** Upper bound for a request's interrupt budget, and the budget when a request names none. */
	maxInterruptBudget?: number;
	/** Upper bound for a request's VM memory, and the limit when a request names none. */
	maxMemoryLimitBytes?: number;
}

/**
 * Remote side of {@link RemoteCodemodeSandbox}: runs one execution's VM on this thread and
 * forwards everything it reports through `exchange`. Resolves once the VM has stopped and the
 * terminal message has been delivered, or the client asked to stop. Never rejects.
 */
export function serveCodemodeRemote(
	request: CodemodeRemoteRequest,
	exchange: CodemodeRemoteExchange,
	options: CodemodeServeOptions,
): Promise<void> {
	const maxBudget = options.maxInterruptBudget ?? DEFAULT_INTERRUPT_BUDGET;
	const budget = Math.min(request.interruptBudget ?? maxBudget, maxBudget);
	const requestedMemory = request.data.memoryLimitBytes;
	const maxMemory = options.maxMemoryLimitBytes;
	const memoryLimitBytes =
		requestedMemory === undefined
			? maxMemory
			: maxMemory === undefined
				? requestedMemory
				: Math.min(requestedMemory, maxMemory);
	const data: VmStartData = { ...request.data, memoryLimitBytes };

	return new Promise<void>((resolve) => {
		let channel: VmChannel | undefined;
		let ended = false;
		let buffered: CodemodeRemoteMessage[] = [];
		let bufferedChars = 0;
		/** Replies that arrived before the launcher returned the channel. */
		const unsent: HostToWorkerMessage[] = [];

		const takeBuffer = (): CodemodeRemoteMessage[] => {
			const batch = buffered;
			buffered = [];
			bufferedChars = 0;
			return batch;
		};
		const end = (terminal: CodemodeRemoteMessage | undefined): void => {
			if (ended) return;
			ended = true;
			const batch = takeBuffer();
			const delivered = terminal ? exchange([...batch, terminal]).catch(() => null) : Promise.resolve();
			void delivered
				.then(() => channel?.stop())
				.catch(() => undefined)
				.then(() => resolve());
		};
		const reply = (message: CodemodeRemoteReply): void => {
			if (ended || message === null) return;
			if (message.type === "stop") {
				end(undefined);
				return;
			}
			if (channel) channel.post(message);
			else unsent.push(message);
		};
		const onMessage = (message: unknown): void => {
			if (ended) return;
			const typed = message as WorkerToHostMessage;
			switch (typed.type) {
				case "output": {
					buffered.push(typed);
					bufferedChars += typed.item.type === "text" ? typed.item.text.length : typed.item.data.length;
					if (buffered.length >= FLUSH_ITEMS || bufferedChars >= FLUSH_CHARS) {
						exchange(takeBuffer()).then(reply, () => end(undefined));
					}
					break;
				}
				case "started":
					buffered.push(typed);
					break;
				// Sent at once: a host replaying a script waits for it to see that the script issued no further call.
				case "call":
				case "idle":
					exchange([...takeBuffer(), typed]).then(reply, () => end(undefined));
					break;
				default:
					end(typed);
			}
		};

		const launch = inlineLauncher(options.wasm, budget);
		Promise.resolve(
			launch(data, {
				message: onMessage,
				failure: (error) => end({ type: "failure", error }),
			}),
		).then(
			(started) => {
				channel = started;
				if (ended) {
					void started.stop().catch(() => undefined);
					return;
				}
				for (const message of unsent.splice(0)) started.post(message);
			},
			(error: unknown) => end({ type: "failure", error: { kind: "sandbox", message: errorMessage(error) } }),
		);
	});
}

function remoteLauncher(remote: () => CodemodeRemote, interruptBudget: number | undefined): VmLauncher {
	return (data, events) => {
		let stopped = false;
		let settled = false;
		const waiting = new Map<number, (reply: CodemodeRemoteReply) => void>();

		const exchange: CodemodeRemoteExchange = (messages) =>
			new Promise<CodemodeRemoteReply>((resolve) => {
				if (stopped || !Array.isArray(messages)) {
					resolve({ type: "stop" });
					return;
				}
				// Register the waiter first: the host may answer a call synchronously, for example when the
				// tool throws before returning a promise.
				const call = messages.find((message) => isWorkerToHostMessage(message) && message.type === "call");
				if (call?.type === "call") waiting.set(call.id, resolve);
				else resolve(null);
				for (const message of messages) {
					if (typeof message === "object" && message !== null && message.type === "failure") {
						settled = true;
						events.failure(message.error);
						continue;
					}
					// Malformed messages still go to the host, which fails the execution as a broken bridge.
					events.message(message);
					if (isWorkerToHostMessage(message) && (message.type === "done" || message.type === "crash"))
						settled = true;
				}
			});

		let target: CodemodeRemote;
		try {
			target = remote();
		} catch (error) {
			throw new Error(`Failed to reach the remote sandbox: ${errorMessage(error)}`);
		}
		const request: CodemodeRemoteRequest = interruptBudget === undefined ? { data } : { data, interruptBudget };
		Promise.resolve()
			.then(() => target.execute(request, exchange))
			.then(
				() => {
					if (!settled && !stopped) {
						events.failure({ kind: "sandbox", message: "Remote sandbox returned before the script settled" });
					}
				},
				(error: unknown) => {
					if (!stopped)
						events.failure({ kind: "sandbox", message: `Remote sandbox failed: ${errorMessage(error)}` });
				},
			);

		return {
			post: (message) => {
				const resolve = waiting.get(message.id);
				if (!resolve) return;
				waiting.delete(message.id);
				resolve(message);
			},
			stop: async () => {
				stopped = true;
				for (const resolve of waiting.values()) resolve({ type: "stop" });
				waiting.clear();
			},
		};
	};
}

/**
 * Runs each execution's VM on a remote, usually a Cloudflare Durable Object deployed with
 * `CodemodeSandboxDurableObject`, while tools run here. Same API and results as
 * `CodemodeSandbox`, so it can replace it. Differences: a script that computes without calling a
 * tool is limited by the remote's interrupt budget rather than `timeoutMs`, and after a deadline or
 * abort the remote VM keeps computing until it next calls a tool or uses up that budget.
 */
export class RemoteCodemodeSandbox extends CodemodeSandboxBase {
	constructor(options: RemoteCodemodeSandboxOptions) {
		super(options, remoteLauncher(options.remote, options.interruptBudget));
	}
}
