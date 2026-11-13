// Natives (§13): the handle `self.open` returns, a value opened during activation and closed with a reason when its
// attempt ends; `within`, which bounds a close or a drain by a timeout; and the drain's admission of running work.

import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import { type Context, withAbortSignal, withTelemetry } from "../context/index.ts";
import { ChordError } from "../data/index.ts";
import { chordSpans, ended, spanFailed, untraced } from "../telemetry.ts";
import type { HostError } from "./host.ts";

/** Why a native closes: its object ended or its attempt failed (`end`), the host closes (`close`), a reload (slice 7). */
export type NativeCloseReason = { readonly kind: "end" } | { readonly kind: "close" } | { readonly kind: "reload" };

/** A native's handle. */
export interface Native<T> {
	/** The opened value: throws `not_ready` until its open resolved and `released` once its close started. */
	readonly value: T;
}

/** What `self.open` takes besides the open and the close. */
export type NativeOptions = {
	/** How long its close may take; the host's `closeTimeout` by default. */
	readonly closeTimeout?: number;
};

/** A close that threw, as reported. */
export type CloseFailed = Extract<HostError, { readonly kind: "close_failed" }>;

/**
 * Where a native belongs: its object's label, type and its position in declaration order (from 1) for errors, reports
 * and spans, the object's context (every close runs under it, never under the aborted opener's), the host's telemetry
 * adapter (a close is a root span), and where it reports.
 */
type NativeOwner = {
	readonly object: string;
	readonly type: string;
	readonly position: number;
	readonly context: Context;
	readonly telemetry: TelemetryContext;
	/** Its host's `chord.host`. */
	readonly host: string;
	readonly report: (error: HostError) => void;
};

/** What an attempt does with each of its natives, whatever their value's type. */
export interface NativeSlot {
	open(context: Context): Promise<void>;
	close(reason: NativeCloseReason): Promise<CloseFailed | undefined>;
}

/** Where a native stands. `abandoned`: closed while its open was pending, so the late value is closed at once. */
type NativeState<T> =
	| { readonly kind: "unopened" }
	| { readonly kind: "opening" }
	| { readonly kind: "open"; readonly value: T }
	| { readonly kind: "abandoned"; readonly reason: NativeCloseReason }
	| { readonly kind: "closed" };

/** One native of one attempt: opened at most once, closed exactly once. */
export class NativeHandle<T> implements Native<T>, NativeSlot {
	readonly #open: (context: Context) => Promise<T>;
	readonly #close: (value: T, reason: NativeCloseReason, context: Context) => void | Promise<void>;
	readonly #closeTimeout: number;
	readonly #owner: NativeOwner;
	#state: NativeState<T> = { kind: "unopened" };

	constructor(
		open: (context: Context) => Promise<T>,
		close: (value: T, reason: NativeCloseReason, context: Context) => void | Promise<void>,
		closeTimeout: number,
		owner: NativeOwner,
	) {
		this.#open = open;
		this.#close = close;
		this.#closeTimeout = closeTimeout;
		this.#owner = owner;
	}

	get value(): T {
		const state = this.#state;
		if (state.kind === "open") return state.value;
		const name = this.#name();
		if (state.kind === "unopened" || state.kind === "opening") {
			throw new ChordError({ code: "not_ready", message: `${name}: not open yet` });
		}
		throw new ChordError({ code: "released", reason: "closed", message: `${name}: closed` });
	}

	/**
	 * Opens the value in its `chord.open` span (under `context`'s, its attempt's); one that arrives after its attempt was
	 * abandoned is closed at once, a failure reported.
	 */
	async open(context: Context): Promise<void> {
		this.#state = { kind: "opening" };
		const parent = context.telemetry;
		if (untraced(parent)) {
			await this.#opened(await this.#open(context));
			return;
		}
		const { host, type, position } = this.#owner;
		await chordSpans(parent)("chord.open", { "chord.host": host, type, native: position }, async (span) => {
			let value: T;
			try {
				value = await this.#open(withTelemetry(span, context));
			} catch (error) {
				// An open its attempt abandoned (a deadline, an end) was cancelled: no error.
				ended(span, "open_failed", error, context.abortSignal);
				throw error;
			}
			await this.#opened(value);
		});
	}

	/** Closes the value if it is open (a pending open's value is closed when it arrives); resolves with a throw. */
	async close(reason: NativeCloseReason): Promise<CloseFailed | undefined> {
		const state = this.#state;
		this.#state = state.kind === "opening" ? { kind: "abandoned", reason } : { kind: "closed" };
		return state.kind === "open" ? this.#closeValue(state.value, reason) : undefined;
	}

	/** Keeps the value an open resolved with, or closes it at once when the native was closed meanwhile. */
	async #opened(value: T): Promise<void> {
		const state = this.#state;
		if (state.kind !== "abandoned") {
			this.#state = { kind: "open", value };
			return;
		}
		this.#state = { kind: "closed" };
		const failure = await this.#closeValue(value, state.reason);
		if (failure !== undefined) this.#owner.report(failure);
	}

	/**
	 * Runs the close under the object's context (in a `chord.close` root span), aborted at the close timeout, and waits
	 * for it up to then; longer is reported.
	 */
	async #closeValue(value: T, reason: NativeCloseReason): Promise<CloseFailed | undefined> {
		const { telemetry, host, type, position } = this.#owner;
		if (untraced(telemetry)) return this.#closeWithin(value, reason, this.#owner.context);
		const attributes = { "chord.host": host, type, native: position, reason: reason.kind };
		return chordSpans(telemetry)("chord.close", attributes, async (span) => {
			const failure = await this.#closeWithin(value, reason, withTelemetry(span, this.#owner.context));
			if (failure !== undefined) spanFailed(span, "close_failed", failure.error);
			return failure;
		});
	}

	/** `#closeValue`'s close under `context`. */
	async #closeWithin(value: T, reason: NativeCloseReason, context: Context): Promise<CloseFailed | undefined> {
		const { object, position, report } = this.#owner;
		const at = { object, native: { kind: "native", position } } as const;
		const timeout = new AbortController();
		const closing = (async () => this.#close(value, reason, withAbortSignal(timeout.signal, context)))();
		try {
			if ((await within(closing, this.#closeTimeout)) === "timeout") {
				timeout.abort(new ChordError({ code: "aborted", message: `${this.#name()}: close timed out` }));
				report({ kind: "close_timeout", ...at });
			}
			return undefined;
		} catch (error) {
			return { kind: "close_failed", ...at, error };
		}
	}

	#name(): string {
		return `${this.#owner.object} native #${this.#owner.position}`;
	}
}

/** Whether `promise` settled within `ms` (it rejects when `promise` does first); `promise` itself runs on. */
export async function within(promise: Promise<unknown>, ms: number): Promise<"settled" | "timeout"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(resolve, ms, "timeout");
	});
	try {
		return await Promise.race([promise.then(() => "settled" as const), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** Whether the `size` pieces of work in `drain` settled within `ms` (at once when there is none). */
export async function drained(
	drain: Iterable<Promise<unknown>>,
	size: number,
	ms: number,
): Promise<"settled" | "timeout"> {
	return size === 0 ? "settled" : within(Promise.allSettled(drain), ms);
}
