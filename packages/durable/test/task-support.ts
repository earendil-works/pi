import type { Context } from "@earendil-works/chord";
import { createModels } from "@earendil-works/pi-ai";
import {
	type AnyTask,
	createRegistry,
	defineExtension,
	Harness,
	type HarnessOptions,
	type HarnessSettings,
	type Registry,
	type RegistryReader,
	type Storage,
} from "@earendil-works/pi-durable";
import { context, flush } from "./session-support.ts";

export type Deferred<T = void> = {
	readonly promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
};

export function deferred<T = void>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

/** Reject with the signal's reason once it aborts; for handlers that block until cancelled. */
export function aborted(signal: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		if (signal.aborted) reject(signal.reason);
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

/** Flush macrotask turns until `check` holds. */
export async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (await check()) return;
		await flush();
	}
	throw new Error("Condition was not reached");
}

/** Whether `promise` has settled after pending work flushes. */
export async function settled(promise: Promise<unknown>): Promise<boolean> {
	let done = false;
	promise.then(
		() => {
			done = true;
		},
		() => {
			done = true;
		},
	);
	await flush();
	return done;
}

/**
 * A host timer whose wakes the test delivers, like an alarm or a delayed queue message. It records every armed
 * deadline with its context and, like a careless host, ignores cancellation.
 */
export function manualTimer(): {
	readonly timer: NonNullable<HarnessOptions["timer"]>;
	readonly armed: { readonly until: number; readonly context: Context }[];
	/** Resolve every pending wait. */
	deliver(): void;
} {
	const armed: { readonly until: number; readonly context: Context }[] = [];
	let waits: Deferred[] = [];
	return {
		timer: (until, context) => {
			armed.push({ until, context });
			const wait = deferred();
			waits.push(wait);
			return wait.promise;
		},
		armed,
		deliver: () => {
			const delivered = waits;
			waits = [];
			for (const wait of delivered) wait.resolve();
		},
	};
}

/** Open a Harness whose registry holds `tasks`; failures passed to `onReport` are collected. */
export async function openTasks(
	storage: Storage,
	tasks: readonly AnyTask[],
	options: {
		readonly registry?: Registry;
		readonly now?: () => number;
		readonly timer?: NonNullable<HarnessOptions["timer"]>;
		readonly settings?: HarnessSettings;
	} = {},
): Promise<{ readonly harness: Harness; readonly registry: Registry; readonly reports: unknown[] }> {
	const registry = options.registry ?? createRegistry();
	if (tasks.length > 0) registry.install(defineExtension({ name: "tasks", tasks }));
	const reports: unknown[] = [];
	const harness = await Harness.open(
		storage,
		{
			models: createModels(),
			registry,
			onReport: (error) => reports.push(error),
			...(options.now === undefined ? {} : { now: options.now }),
			...(options.timer === undefined ? {} : { timer: options.timer }),
			...(options.settings === undefined ? {} : { settings: options.settings }),
		},
		context,
	);
	return { harness, registry, reports };
}

/** Next state that completes a task with `result`. */
export function completed<R>(result: R) {
	return { status: "terminal", outcome: { status: "completed", result } } as const;
}

/** Next state that aborts a task. */
export function abortedWith(reason: string) {
	return { status: "terminal", outcome: { status: "aborted", reason } } as const;
}

/** Registry reader that counts live subscriptions. */
export function countingReader(registry: Registry): RegistryReader & { subscriptions(): number } {
	let count = 0;
	return {
		snapshot: () => registry.snapshot(),
		subscribe: (listener) => {
			count++;
			const unsubscribe = registry.subscribe(listener);
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				count--;
				unsubscribe();
			};
		},
		subscriptions: () => count,
	};
}
