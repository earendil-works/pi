/**
 * Drives one QuickJS VM through one script, independent of the transport that connects it to the
 * host. The worker thread, the in-thread launcher, and the remote server all run the VM through
 * this module, so the bridge between prelude and host exists once.
 *
 * Contract with the caller:
 * - `post` receives every message for the host, synchronously from inside VM callbacks. The
 *   caller must not re-enter the VM from `post` (no `deliver`, no `dispose`); a worker posts to
 *   another thread, and the in-thread launcher defers delivery to a microtask.
 * - `deliver` hands the VM a tool result and runs the script until it waits again. It must only be
 *   called while the VM is idle, which holds for any caller that never re-enters from `post`.
 * - `shouldInterrupt` is polled by QuickJS while the script runs, and here between batches of
 *   promise jobs. Returning true throws an uncatchable error in the script; the VM then reports
 *   `crash` or a failed `done`. The job batches matter for a script such as `while (true) await
 *   null`: every iteration is a separate job that executes only a few opcodes, so QuickJS's own
 *   polling, which counts opcodes, would let it run for a long time between polls.
 * - The VM never decides on its own when it is finished: after `done` or `crash` it stays alive
 *   until the caller disposes it (or terminates the worker that hosts it).
 *
 * Failures after the VM exists are reported as a `crash` message; `startVm` only rejects when the
 * VM cannot be created at all.
 *
 * Deterministic mode (`data.deterministic`, used by `CodemodeSandboxBase.start()`): a script must make the same
 * calls with the same arguments every time it runs with the same results, so a host can replay it after a restart.
 * The VM is otherwise deterministic, because it only runs when the host delivers something and has no timers.
 * What remains is fixed here:
 * - Time: every WASI clock reads virtual time, `startedAt` and then the `now` of the result being processed, never going backwards.
 *   While the context is created, the realtime clock reads a value derived from the seed instead, because QuickJS
 *   seeds `Math.random()` from the first clock read, and which read comes first is the engine's business.
 * - Randomness: `random_get` draws from a PRNG over the seed.
 * - Timezone: UTC, not the host's.
 * - Garbage collection: `WeakRef` and `FinalizationRegistry` are not available; collection timing is not.
 * - Delivery order: results carry a `seq` and are applied strictly in that order, buffering early ones, because a
 *   transport (RPC replies) may deliver them in another order than the host sent them.
 * The VM reports `started` with its fingerprint before the script runs, and `idle` with the number of calls issued
 * after each drain, so the host can check a replay step by step.
 */
import { Intrinsics, JSException, type JSValueHandle, MAX_STACK_SIZE, QuickJS } from "quickjs-wasi";
import type { CodemodeWasmModule } from "../wasm.ts";
import { PRELUDE_SOURCE } from "./prelude-source.ts";
import type { HostToWorkerMessage, VmStartData, WorkerToHostMessage } from "./protocol.ts";

export interface VmSession {
	deliver(message: HostToWorkerMessage): void;
	/** Releases the VM's wasm instance. The session must not be used afterwards. */
	dispose(): void;
}

export interface StartVmOptions {
	data: VmStartData;
	wasm: CodemodeWasmModule;
	/**
	 * QuickJS's guard on its own stack, which turns deep recursion into a catchable `RangeError`.
	 * The wasm frames also use the host thread's native stack, so the guard must trip before that
	 * stack runs out: a host overflow fails the whole execution instead. Default: `MAX_STACK_SIZE`
	 * (512 KiB), which fits the 4 MB stack of a Node worker thread but not a 1 MB main thread.
	 */
	maxStackSize?: number;
	/** Interrupt polls this VM may use, if the launcher counts them; part of the fingerprint. */
	interruptBudget?: number;
	post(message: WorkerToHostMessage): void;
	shouldInterrupt(): boolean;
}

/**
 * Bumped whenever this module or the prelude changes what a deterministic script observes, beyond what the
 * fingerprint's other parts (engine versions, prelude hash, limits) already capture.
 */
const DETERMINISTIC_VERSION = 1;

/** FNV-1a over UTF-16 code units, as 8 hex digits: identifies the prelude in the fingerprint. */
function fnv1a(text: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

const PRELUDE_HASH = fnv1a(PRELUDE_SOURCE);

/** mulberry32: a small, fast PRNG; one 32-bit draw per call. */
function prng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = Math.imul(state ^ (state >>> 15), 1 | state);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return (value ^ (value >>> 14)) >>> 0;
	};
}

/** The deterministic VM's clock: seed-derived while the context is created, then virtual time. */
interface VirtualClock {
	creating: boolean;
	startedAt: number;
	now: number;
	seed: number;
}

/** WASI clock and random functions for deterministic mode, on top of {@link discardOutput}. */
function deterministicWasi(clock: VirtualClock) {
	const random = prng(clock.seed ^ 0x9e3779b9);
	return (memory: { readonly buffer: ArrayBufferLike }) => ({
		...discardOutput(memory),
		clock_time_get(clockId: number, _precision: bigint, resultPtr: number): number {
			let nanoseconds: bigint;
			// QuickJS seeds Math.random() from this reading in microseconds and turns 0 into 1, so seed s reads s + 1.
			if (clock.creating) nanoseconds = clockId === 0 ? BigInt(clock.seed + 1) * 1000n : 0n;
			else if (clockId === 0) nanoseconds = BigInt(Math.round(clock.now)) * 1_000_000n;
			else nanoseconds = BigInt(Math.round(clock.now - clock.startedAt)) * 1_000_000n;
			new DataView(memory.buffer).setBigUint64(resultPtr, nanoseconds, true);
			return 0;
		},
		random_get(bufPtr: number, bufLen: number): number {
			const bytes = new Uint8Array(memory.buffer, bufPtr, bufLen);
			for (let index = 0; index < bufLen; index += 4) {
				const value = random();
				for (let byte = 0; byte < 4 && index + byte < bufLen; byte++) bytes[index + byte] = value >>> (byte * 8);
			}
			return 0;
		},
	});
}

/**
 * QuickJS writes engine diagnostics to fd 1 and 2, which the default shim
 * forwards to the host's stdout and stderr. That output belongs to the host
 * application (for example a TUI), so it is discarded. Reporting every byte as
 * written keeps libc from retrying.
 */
function discardOutput(memory: { readonly buffer: ArrayBufferLike }) {
	return {
		fd_write(_fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number {
			const view = new DataView(memory.buffer);
			let written = 0;
			for (let i = 0; i < iovsLen; i++) {
				written += view.getUint32(iovsPtr + i * 8 + 4, true);
			}
			view.setUint32(nwrittenPtr, written, true);
			return 0;
		},
	};
}

function describeException(error: JSException): string {
	const head = error.message ? `${error.name}: ${error.message}` : error.name;
	const stack = error.stack?.trimEnd();
	return JSON.stringify({ name: error.name, message: error.message, stack: stack ? `${head}\n${stack}` : head });
}

/** Promise jobs run between two `shouldInterrupt` polls while draining the job queue. */
const JOBS_PER_POLL = 50;

function crashMessage(error: unknown): WorkerToHostMessage {
	return { type: "crash", message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
}

export async function startVm(options: StartVmOptions): Promise<VmSession> {
	const { data, post } = options;
	const maxStackSize = options.maxStackSize ?? MAX_STACK_SIZE;
	const deterministic = data.deterministic;
	const clock: VirtualClock | undefined = deterministic && {
		creating: true,
		startedAt: deterministic.startedAt,
		now: deterministic.startedAt,
		seed: deterministic.seed >>> 0,
	};
	const vm = await QuickJS.create({
		wasm: options.wasm,
		memoryLimit: data.memoryLimitBytes,
		// Without a guard, deep recursion overflows the wasm stack and traps instead of throwing a
		// catchable RangeError.
		maxStackSize,
		interruptHandler: options.shouldInterrupt,
		wasi: clock ? deterministicWasi(clock) : discardOutput,
		...(clock ? { timezoneOffset: 0, intrinsics: Intrinsics.ALL & ~Intrinsics.WEAK_REF } : {}),
	});
	if (clock) clock.creating = false;
	let disposed = false;
	/** Calls the script has issued, tools and globals; reported with every `idle`. */
	let issued = 0;
	/** Deterministic mode: the next result to apply, and results that arrived before it. */
	let nextSeq = 1;
	/** The result being processed, 0 during the script's first run; reported with `done`. */
	let current = 0;
	const early = new Map<number, HostToWorkerMessage>();
	const apply = (message: HostToWorkerMessage): void => {
		vm.withScope(() => {
			vm.callFunction(
				settle,
				api,
				vm.newNumber(message.id),
				message.ok ? vm.true : vm.false,
				message.payload === undefined ? vm.undefined : vm.newString(message.payload),
				message.properties === undefined ? vm.undefined : vm.newString(message.properties),
			);
		});
		drain();
	};
	const session: VmSession = {
		deliver(message) {
			if (disposed) return;
			try {
				if (!clock) {
					apply(message);
					return;
				}
				const { seq } = message;
				if (seq === undefined || !Number.isInteger(seq) || seq < nextSeq || early.has(seq)) {
					throw new Error(`Result ${message.id} has sequence number ${seq}, expected ${nextSeq} or later, once`);
				}
				early.set(seq, message);
				for (let next = early.get(nextSeq); next !== undefined; next = early.get(nextSeq)) {
					early.delete(nextSeq);
					// Never backwards: a resumed host's clock may be behind the one that started the run.
					if (next.now !== undefined && Number.isFinite(next.now)) clock.now = Math.max(clock.now, next.now);
					current = nextSeq;
					apply(next);
					post({ type: "idle", seq: nextSeq, issued });
					nextSeq++;
				}
			} catch (error) {
				post(crashMessage(error));
			}
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			vm.dispose();
		},
	};

	let api: JSValueHandle;
	let settle: JSValueHandle;
	let stalled: JSValueHandle;
	// `executePendingJobs()` runs the queue to empty without a chance to interrupt, so jobs run one at a
	// time through the (internal, but public) exports; quickjs-wasi is pinned to an exact version.
	const exports = vm._getExports();
	/** Run queued jobs, then fail a script that waits on nothing that can ever resume it. */
	const drain = () => {
		let jobs = 0;
		while (exports.qjs_is_job_pending()) {
			// A job only fails for uncatchable errors, such as an interrupt.
			if (exports.qjs_execute_pending_job() < 0) throw new Error("Promise job failed");
			if (++jobs % JOBS_PER_POLL === 0 && options.shouldInterrupt()) throw new Error("Execution interrupted");
		}
		vm.callFunction(stalled, api).dispose();
	};

	try {
		// Called from the prelude with primitives only.
		const bridge = vm.newFunction("bridge", (kind, a, b, c) => {
			switch (kind.toString()) {
				case "call":
				case "global":
					issued++;
					post({
						type: "call",
						id: a.toNumber(),
						target: kind.toString() === "call" ? "tool" : "global",
						name: b.toString(),
						args: c === undefined || c.isUndefined ? undefined : c.toString(),
					});
					break;
				case "output":
					post({
						type: "output",
						item:
							a.toString() === "image"
								? { type: "image", data: b.toString(), mimeType: c.toString() }
								: a.toString() === "console"
									? { type: "text", text: b.toString(), console: true }
									: { type: "text", text: b.toString() },
					});
					break;
				case "done": {
					// The host stops the VM on `done`, so the `idle` of this drain never arrives: report its numbers here.
					const during = clock ? { during: { seq: current, issued } } : {};
					if (a.toBoolean()) {
						post({
							type: "done",
							ok: true,
							value: b === undefined || b.isUndefined ? undefined : b.toString(),
							writes: c.toString(),
							...during,
						});
					} else {
						post({ type: "done", ok: false, error: b.toString(), ...during });
					}
					break;
				}
			}
			return vm.undefined;
		});

		// These handles live as long as the VM, which the caller disposes as a whole.
		api = vm.withScope((scope) =>
			scope.escape(
				vm.callFunction(
					vm.evalCode(PRELUDE_SOURCE, "codemode-prelude.js"),
					vm.undefined,
					bridge,
					vm.newString(JSON.stringify(data.tools)),
					vm.newString(JSON.stringify(data.globals)),
					vm.newString(JSON.stringify(data.store)),
				),
			),
		);
		settle = api.getProp("settle");
		const run = api.getProp("run");
		stalled = api.getProp("stalled");
		if (clock) {
			const versions = vm.versions;
			const budget = options.interruptBudget ?? "none";
			post({
				type: "started",
				fingerprint: `quickjs-wasi ${versions["quickjs-wasi"]}, quickjs ${versions.quickjs}, prelude ${PRELUDE_HASH}, deterministic ${DETERMINISTIC_VERSION}, stack ${maxStackSize}, heap ${data.memoryLimitBytes ?? "none"}, budget ${budget}`,
			});
		}

		// The prefix shares the first line with the script so reported line numbers
		// match the script as written.
		let fn: JSValueHandle;
		try {
			fn = vm.evalCode(`(async (tools, console) => {${data.code}\n})`, "codemode.js");
		} catch (error) {
			if (!(error instanceof JSException)) throw error;
			post({ type: "done", ok: false, error: describeException(error) });
			return session;
		}
		vm.callFunction(run, api, fn).dispose();
		fn.dispose();
		drain();
		if (clock) post({ type: "idle", seq: 0, issued });
	} catch (error) {
		post(crashMessage(error));
	}
	return session;
}
