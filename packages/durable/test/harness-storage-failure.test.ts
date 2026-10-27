import { runInNewContext } from "node:vm";
import type { Context } from "@earendil-works/chord";
import { createModels } from "@earendil-works/pi-ai";
import {
	createRegistry,
	defineExtension,
	defineTask,
	Harness,
	type Id,
	LiveDoc,
	MemoryStorage,
	StorageRequestError,
	type TaskId,
	watchEvents,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { safeNow } from "../src/harness/harness.ts";
import { conversationViews } from "../src/harness/view.ts";
import { contained } from "../src/session/session.ts";
import { ControlledStorage, context } from "./session-support.ts";
import { aborted, deferred, openTasks } from "./task-support.ts";

/** Waits for its signal, records that it saw it, and ends `aborted` through its abort handler. */
const signals: string[] = [];
const Waiting = defineTask<null, { phase: "work" }, null>({
	name: "test.waiting",
	version: 1,
	initial: () => ({ phase: "work" }),
	phases: {
		work: async (_task, runtime) => {
			await aborted(runtime.signal).catch(() => {});
			signals.push("aborted");
		},
	},
	abort: async (_task, runtime, abortContext) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), abortContext);
	},
});

/**
 * Fails each Storage method named in `failing` once, with `error`. A scan of entries with a limit above 1 is the context
 * read's scan of its range, off the Session line; `heldRange` holds it until released.
 */
class FailingCalls extends ControlledStorage {
	readonly error = new Error("disk gone");
	readonly failing = new Set<string>();
	heldRange: { readonly entered: ReturnType<typeof deferred<void>>; readonly release: Promise<unknown> } | undefined;
	#fail(method: string): void {
		if (this.failing.delete(method)) throw this.error;
	}
	override async task(...args: Parameters<MemoryStorage["task"]>) {
		this.#fail("task");
		return super.task(...args);
	}
	override async scanEntries(...args: Parameters<MemoryStorage["scanEntries"]>) {
		if (args[1] > 1) {
			const held = this.heldRange;
			if (held !== undefined) {
				held.entered.resolve();
				await held.release;
			}
			this.#fail("scanRange");
		}
		return super.scanEntries(...args);
	}
	override async mintId<I extends Id<string>>(): Promise<I> {
		this.#fail("mintId");
		return super.mintId<I>();
	}
}

async function started(storage: MemoryStorage) {
	signals.length = 0;
	const opened = await openTasks(storage, [Waiting]);
	const root = await opened.harness.root(context);
	return { ...opened, root };
}

async function running(harness: Harness, id: TaskId): Promise<void> {
	while ((await harness.getTask(id, context))?.state.status !== "running") {
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

describe("a failed Storage call", () => {
	it("ends everything with the first error: the call, later calls, waits, watches, streams, running tasks", async () => {
		const storage = new ControlledStorage();
		const { harness, root, reports } = await started(storage);
		const id = await root.commit(
			(tx) => tx.createTask(Waiting, null, { ownership: { kind: "conversation" } }),
			context,
		);
		harness.resume();
		await running(harness, id);
		const task = harness.waitForTask(id, context);
		const idle = harness.waitForIdle(context);
		const watch = (await harness.watchDoc(LiveDoc, root.id, context))!;
		const stream = await watchEvents(harness, root.id, context);
		stream.start(async () => {});

		const failure = new Error("disk gone");
		storage.failNextCommit(failure);
		// The call that hit it gets the storage error itself.
		await expect(root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context)).rejects.toBe(failure);

		const failed = { name: "SessionFailed", cause: failure };
		await expect(task).rejects.toMatchObject(failed);
		await expect(idle).rejects.toMatchObject(failed);
		expect(await watch.closed).toEqual({ reason: "failed", error: failure });
		expect(await stream.closed).toEqual({ reason: "failed", error: failure });
		// Every later call, and a wait that starts now.
		await expect(harness.getTask(id, context)).rejects.toMatchObject(failed);
		await expect(harness.waitForIdle(context)).rejects.toMatchObject(failed);
		await expect(root.submit({ type: "input", content: "x" }, context)).rejects.toMatchObject(failed);
		expect(await harness.closed).toEqual({ reason: "failed", error: failure });
		expect(signals).toEqual(["aborted"]);
		expect(reports).toEqual([failure]);
		await harness.close(context);
	});

	it("fails it from a read off the Session line, as a context read makes", async () => {
		const storage = new FailingCalls();
		const { harness, root, reports } = await started(storage);
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context);
		storage.failing.add("scanRange");
		await expect(root.context(context)).rejects.toBe(storage.error);
		expect(await harness.closed).toEqual({ reason: "failed", error: storage.error });
		expect(reports).toEqual([storage.error]);
		await harness.close(context);
	});

	it("ends Storage calls underway with SessionFailed, and closes once they have settled", async () => {
		const storage = new FailingCalls();
		const { harness, root } = await started(storage);
		const release = deferred();
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context);
		storage.heldRange = { entered: deferred(), release: release.promise };
		const reading = root.context(context);
		await storage.heldRange.entered.promise;
		// Another call fails the Session while the context read is underway.
		storage.failing.add("mintId");
		await expect(root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context)).rejects.toBe(storage.error);
		let closed = false;
		void harness.closed.then(() => {
			closed = true;
		});
		for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
		expect(closed).toBe(false);
		// The read succeeds at the backend, yet its caller gets the failure: nothing it read is used.
		release.resolve();
		await expect(reading).rejects.toMatchObject({ name: "SessionFailed", cause: storage.error });
		expect(await harness.closed).toEqual({ reason: "failed", error: storage.error });
		await harness.close(context);
	});

	it("closes the backend only after a paged read underway, which cannot start another page", async () => {
		const pages: string[] = [];
		const firstPage = deferred();
		const releaseFirst = deferred();
		class Paged extends ControlledStorage {
			override async scanEntries(...args: Parameters<MemoryStorage["scanEntries"]>) {
				if (args[1] > 1) {
					pages.push(args[2] === undefined ? "first" : "next");
					if (args[2] === undefined) {
						firstPage.resolve();
						await releaseFirst.promise;
					}
				}
				return super.scanEntries(...args);
			}
			override async close(closeContext: Context): Promise<void> {
				pages.push("close");
				return super.close(closeContext);
			}
		}
		const storage = new Paged();
		const { harness, root } = await started(storage);
		// More entries than one page of the context read.
		await root.commit(async (tx) => {
			for (let n = 0; n < 300; n++) await tx.appendEntry(root.id, { kind: "note" });
		}, context);
		const reading = root.context(context);
		await firstPage.promise;
		const closing = harness.close(context);
		releaseFirst.resolve();
		await expect(reading).rejects.toThrow("is closed");
		await closing;
		expect(pages).toEqual(["first", "close"]);
		expect(await harness.closed).toEqual({ reason: "closed" });
	});

	it("fails it when Storage cannot close; an earlier failure stays the cause", async () => {
		const closeError = new Error("close failed");
		class FailingClose extends ControlledStorage {
			override async close(closeContext: Context): Promise<void> {
				await super.close(closeContext);
				throw closeError;
			}
		}
		const healthy = await started(new FailingClose());
		await expect(healthy.harness.close(context)).rejects.toBe(closeError);
		expect(await healthy.harness.closed).toEqual({ reason: "failed", error: closeError });
		expect(healthy.reports).toEqual([closeError]);

		const storage = new FailingClose();
		const failed = await started(storage);
		const failure = new Error("disk gone");
		storage.failNextCommit(failure);
		await expect(failed.root.commit((tx) => tx.appendEntry(failed.root.id, { kind: "note" }), context)).rejects.toBe(
			failure,
		);
		expect(await failed.harness.closed).toEqual({ reason: "failed", error: failure });
		expect(failed.reports).toEqual([failure]);
	});

	it("rejects the Harness's own calls with SessionFailed after a failure", async () => {
		const storage = new ControlledStorage();
		const { harness, root } = await started(storage);
		const failure = new Error("disk gone");
		storage.failNextCommit(failure);
		await expect(root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context)).rejects.toBe(failure);
		const failed = { name: "SessionFailed", cause: failure };
		expect(() => harness.resume()).toThrow(expect.objectContaining(failed));
		await expect(harness.root(context)).rejects.toMatchObject(failed);
		await expect(harness.conversation(root.id, context)).rejects.toMatchObject(failed);
		await expect(harness.createConversation({ ownership: { kind: "ownerless" } }, context)).rejects.toMatchObject(
			failed,
		);
		await harness.close(context);
	});

	it("ends what a task holds as failed, not as cancelled by its signal", async () => {
		const ends: unknown[] = [];
		const watching = deferred();
		const Watcher = defineTask<null, { phase: "work" }, null>({
			name: "test.watcher",
			version: 1,
			initial: () => ({ phase: "work" }),
			phases: {
				work: async (_task, runtime, phaseContext) => {
					const doc = (await runtime.watchDoc(LiveDoc, runtime.conversationId, phaseContext))!;
					const handle = (await runtime.conversation(runtime.conversationId, phaseContext))!;
					const idle = handle.waitForIdle(phaseContext).then(
						() => "resolved",
						(error: Error) => error.name,
					);
					watching.resolve();
					ends.push(await doc.closed, await idle);
				},
			},
			abort: async () => {},
		});
		const storage = new ControlledStorage();
		const opened = await openTasks(storage, [Watcher]);
		const root = await opened.harness.root(context);
		await root.commit((tx) => tx.createTask(Watcher, null, { ownership: { kind: "conversation" } }), context);
		opened.harness.resume();
		await watching.promise;
		const failure = new Error("disk gone");
		storage.failNextCommit(failure);
		await expect(root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context)).rejects.toBe(failure);
		await opened.harness.closed;
		expect(ends).toEqual([{ reason: "failed", error: failure }, "SessionFailed"]);
		await opened.harness.close(context);
	});

	it("fails it from a failed ID mint", async () => {
		const storage = new FailingCalls();
		const { harness, root } = await started(storage);
		storage.failing.add("mintId");
		await expect(root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context)).rejects.toBe(storage.error);
		expect(await harness.closed).toEqual({ reason: "failed", error: storage.error });
		await harness.close(context);
	});

	it("does not commit what a callback did after it caught a failed read", async () => {
		const storage = new FailingCalls();
		const { harness, root } = await started(storage);
		const written = storage.admittedCommits.length;
		storage.failing.add("task");
		await expect(
			root.commit(async (tx) => {
				await tx.task(1 as TaskId).catch(() => {});
				await tx.appendEntry(root.id, { kind: "note" });
			}, context),
		).rejects.toMatchObject({ name: "SessionFailed", cause: storage.error });
		expect(storage.admittedCommits.length).toBe(written);
		await harness.close(context);
	});

	it("fails it for a StorageRequestError from a commit, whose effect is unknown", async () => {
		const storage = new ControlledStorage();
		const { harness, root } = await started(storage);
		const rejection = new StorageRequestError("bad batch");
		storage.failNextCommit(rejection);
		await expect(root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context)).rejects.toBe(rejection);
		expect(await harness.closed).toEqual({ reason: "failed", error: rejection });
		await harness.close(context);
	});

	it("fails only the call for an invalid request", async () => {
		const { harness, root, reports } = await started(new MemoryStorage());
		const entry = await root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context);
		const requests: (() => Promise<unknown>)[] = [
			() => root.entries({}, 10, { after: "x" }, context),
			async () => {
				const page = await root.entries({ order: "ascending" }, 1, undefined, context);
				return root.entries({ order: "descending" }, 1, page.next ?? { after: 1, order: "ascending" }, context);
			},
			() => root.commit((tx) => tx.scanEntries({ conversationId: 999_999 as never }, 10), context),
			// `pi.live` keeps no history.
			() => harness.snapshotAsOf(LiveDoc as never, root.id, entry.id, context),
		];
		for (const request of requests) {
			await expect(request()).rejects.toMatchObject({ name: "StorageRequestError" });
		}
		await expect(root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context)).resolves.toBeDefined();
		let ended = false;
		void harness.closed.then(() => {
			ended = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(ended).toBe(false);
		expect(reports).toEqual([]);
		await harness.close(context);
	});

	it("fails it for a throw in its own commit listeners, which would leave memory behind storage", async () => {
		const storage = new ControlledStorage();
		const { harness, root, reports } = await started(storage);
		const bug = new Error("listener bug");
		(harness as unknown as { observeCommits(listener: () => void): void }).observeCommits(() => {
			throw bug;
		});
		// The commit itself is durable and resolves; the Session fails behind it.
		await expect(root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context)).resolves.toBeDefined();
		expect(await harness.closed).toEqual({ reason: "failed", error: bug });
		expect(reports).toEqual([bug]);
		await harness.close(context);
	});

	it("fails it for a storage error during a host close, before the backend closes", async () => {
		const storage = new ControlledStorage();
		const { harness, root, reports } = await started(storage);
		const held = storage.holdCommits();
		const failure = new Error("disk gone");
		storage.failNextCommit(failure);
		const committing = root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context);
		await held.entered;
		const closing = harness.close(context);
		held.release();
		await expect(committing).rejects.toBe(failure);
		await closing;
		expect(await harness.closed).toEqual({ reason: "failed", error: failure });
		expect(reports).toEqual([failure]);
	});

	it("ends an abort that joins a run ignoring its signal, and a reentrant report finds the Session failed", async () => {
		const release = deferred();
		const entered = deferred();
		const Stubborn = defineTask<null, { phase: "work" }, null>({
			name: "test.stubborn",
			version: 1,
			initial: () => ({ phase: "work" }),
			phases: {
				work: async () => {
					entered.resolve();
					await release.promise;
				},
			},
			abort: async () => {},
		});
		const storage = new ControlledStorage();
		const registry = createRegistry();
		registry.install(defineExtension({ name: "tasks", tasks: [Stubborn] }));
		let reentered: Promise<unknown> | undefined;
		const harness: Harness = await Harness.open(
			storage,
			{
				models: createModels(),
				registry,
				onReport: () => {
					reentered ??= harness.waitForIdle(context);
				},
			},
			context,
		);
		const root = await harness.root(context);
		const id = await root.commit(
			(tx) => tx.createTask(Stubborn, null, { ownership: { kind: "conversation" } }),
			context,
		);
		harness.resume();
		await entered.promise;
		const held = storage.holdCommits();
		const aborting = harness.abortTask(id, context);
		await held.entered;
		held.release();
		// The abort mark commits and the abort joins the run, which ignores its signal; then the Session fails.
		const failure = new Error("disk gone");
		await new Promise((resolve) => setTimeout(resolve, 5));
		storage.failNextCommit(failure);
		await expect(root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context)).rejects.toBe(failure);
		await expect(aborting).rejects.toMatchObject({ name: "SessionFailed", cause: failure });
		await expect(reentered).rejects.toMatchObject({ name: "SessionFailed", cause: failure });
		release.resolve();
		await harness.close(context);
	});

	it("does not fail it for a read its caller cancelled", async () => {
		const controller = new AbortController();
		const cancelled = new Error("caller gave up");
		class CancelledRead extends MemoryStorage {
			override async scanEntries(...args: Parameters<MemoryStorage["scanEntries"]>) {
				if (args[3].abortSignal === controller.signal) {
					controller.abort(cancelled);
					throw cancelled;
				}
				return super.scanEntries(...args);
			}
		}
		const { harness, root } = await started(new CancelledRead());
		const cancelling: Context = { ...context, abortSignal: controller.signal };
		await expect(root.context(cancelling)).rejects.toBe(cancelled);
		await expect(root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context)).resolves.toBeDefined();
		await harness.close(context);
	});
});

describe("listener and report errors", () => {
	it("reports a listener or onReport whose promise rejects, without an unhandled rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown) => unhandled.push(error);
		process.on("unhandledRejection", onUnhandled);
		try {
			const { harness, root, reports } = await started(new MemoryStorage());
			const asyncThrow = async () => {
				throw new Error("async listener");
			};
			harness.subscribeCommits(asyncThrow);
			harness.subscribeClose(asyncThrow);
			await root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context);
			await harness.close(context);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(reports.map(String)).toEqual(["Error: async listener", "Error: async listener"]);

			const registry = createRegistry();
			const rejecting = await Harness.open(
				new MemoryStorage(),
				{ models: createModels(), registry, onReport: asyncThrow },
				context,
			);
			rejecting.subscribeCommits(() => {
				throw new Error("sync listener");
			});
			const again = await rejecting.root(context);
			await again.commit((tx) => tx.appendEntry(again.id, { kind: "note" }), context);
			await rejecting.close(context);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("reports a throwing commit or close listener and runs the others; the commit stands", async () => {
		const storage = new MemoryStorage();
		const { harness, root, reports } = await started(storage);
		const seen: string[] = [];
		harness.subscribeCommits(() => {
			throw new Error("commit listener");
		});
		harness.subscribeCommits(() => seen.push("commit"));
		harness.subscribeClose(() => {
			throw new Error("close listener");
		});
		harness.subscribeClose(() => seen.push("close"));
		await expect(root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context)).resolves.toBeDefined();
		await harness.close(context);
		expect(seen).toEqual(["commit", "close"]);
		expect(reports.map(String)).toEqual(["Error: commit listener", "Error: close listener"]);
	});

	it("keeps feeding the other observers of a view when one throws", async () => {
		const { harness, root, reports } = await started(new MemoryStorage());
		const views = conversationViews(harness);
		const failure = new Error("observer broke");
		await views.attach(
			root.id,
			async () => ({
				publication: () => {
					throw failure;
				},
				end: () => {},
			}),
			context,
		);
		const watch = await root.watch(context);
		const seen: unknown[] = [];
		watch.start(async ({ value }) => {
			seen.push(value);
		});
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context);
		while (seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
		expect(reports).toEqual([failure]);
		await harness.close(context);
		expect(await watch.closed).toEqual({ reason: "ended" });
	});

	it("contains a fulfilled thenable that calls only its fulfillment handler", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown) => unhandled.push(error);
		process.on("uncaughtException", onUnhandled);
		process.on("unhandledRejection", onUnhandled);
		try {
			const errors: unknown[] = [];
			// A thenable that, like some libraries' promises, calls only the handler it settles with.
			// biome-ignore lint/suspicious/noThenProperty: the test is about a thenable
			const thenable = { then: (resolve: () => void) => queueMicrotask(() => resolve()) };
			contained(
				() => thenable,
				(error) => errors.push(error),
			);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(errors).toEqual([]);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("uncaughtException", onUnhandled);
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("contains a rejected promise from another realm", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown) => unhandled.push(error);
		process.on("unhandledRejection", onUnhandled);
		try {
			const foreign = runInNewContext("Promise.reject(new Error('foreign'))") as Promise<never>;
			const errors: unknown[] = [];
			contained(
				() => foreign,
				(error) => errors.push(error),
			);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(errors.map(String)).toEqual(["Error: foreign"]);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("reports a throwing watch listener, which ends that watch", async () => {
		const { harness, root, reports } = await started(new MemoryStorage());
		const watch = (await harness.watchDoc(LiveDoc, root.id, context))!;
		const failure = new Error("listener broke");
		watch.start(async () => {
			throw failure;
		});
		await root.commit(async (tx) => {
			(await tx.doc(LiveDoc, root.id)).compactions = [];
		}, context);
		expect(await watch.closed).toEqual({ reason: "listener_error", error: failure });
		expect(reports).toEqual([failure]);
		await harness.close(context);
	});

	it("faults only the task, and ends only the watch, for a thrown value that cannot be formatted", async () => {
		const unformattable = Object.create(null) as object;
		const Throws = defineTask<null, { phase: "work" }, null>({
			name: "test.throws-unformattable",
			version: 1,
			initial: () => ({ phase: "work" }),
			phases: {
				work: async () => {
					throw unformattable;
				},
			},
			abort: async () => {},
		});
		const opened = await openTasks(new MemoryStorage(), [Throws]);
		const root = await opened.harness.root(context);
		const watch = (await opened.harness.watchDoc(LiveDoc, root.id, context))!;
		watch.start(async () => {
			throw unformattable;
		});
		const id = await root.commit(
			(tx) => tx.createTask(Throws, null, { ownership: { kind: "conversation" } }),
			context,
		);
		opened.harness.resume();
		expect((await opened.harness.waitForTask(id, context)).state.outcome).toEqual({
			status: "faulted",
			error: { message: "[object Object]" },
		});
		await root.commit(async (tx) => {
			(await tx.doc(LiveDoc, root.id)).compactions = [];
		}, context);
		expect(await watch.closed).toMatchObject({ reason: "listener_error" });
		await expect(root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context)).resolves.toBeDefined();
		await opened.harness.close(context);
	});

	it("reports a throwing clock once, also when the report handler reads the clock again", () => {
		const reports: unknown[] = [];
		const clock = safeNow(
			() => {
				throw new Error("clock broke");
			},
			(error) => {
				reports.push(error);
				// Reentry, as a handler that commits does: the clock is read again before this report returns.
				if (reports.length < 5) clock();
			},
		);
		expect(clock()).toEqual(expect.any(Number));
		clock();
		expect(reports.map(String)).toEqual(["Error: clock broke"]);
	});

	it("keeps working when onReport throws, and falls back to Date.now when the clock throws", async () => {
		const registry = createRegistry();
		registry.install(defineExtension({ name: "tasks", tasks: [Waiting] }));
		const harness = await Harness.open(
			new MemoryStorage(),
			{
				models: createModels(),
				registry,
				now: () => {
					throw new Error("clock broke");
				},
				onReport: () => {
					throw new Error("report broke");
				},
			},
			context,
		);
		const root = await harness.root(context);
		const id = await root.commit(
			(tx) => tx.createTask(Waiting, null, { ownership: { kind: "conversation" } }),
			context,
		);
		harness.resume();
		await running(harness, id);
		expect((await harness.getTask(id, context))?.startedAt).toEqual(expect.any(Number));
		await harness.abortTask(id, context);
		expect((await harness.waitForTask(id, context)).state.outcome.status).toBe("aborted");
		await harness.close(context);
	});
});
