import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, JsonValue } from "@earendil-works/chord";
import { createModels, fauxAssistantMessage, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
	type Conversation,
	type ConversationId,
	createRegistry,
	defineDoc,
	defineTask,
	defineTool,
	GenerationTask,
	Harness,
	MemoryStorage,
	type Storage,
	type TaskId,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { SessionImpl } from "../src/session/session.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { chatSetup, openChat } from "./chat-support.ts";
import { addHooks, addTask, addTool } from "./harness-support.ts";
import { ControlledStorage, context, flush } from "./session-support.ts";
import { completed, countingReader, deferred, eventually, openTasks, settled } from "./task-support.ts";

type Step = { phase: "run" };

/** A one-phase task running `run` and completing with null. */
function oneStep(name: string, run: () => Promise<void> = async () => {}) {
	return defineTask<null, Step, null>({
		name,
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (_task, runtime, ctx) => {
				await run();
				await runtime.commit(() => completed(null), ctx);
			},
		},
		abort: async () => {},
	});
}

function start(conversation: Conversation, task: ReturnType<typeof oneStep>, background = false): Promise<TaskId> {
	return conversation.commit(
		(tx) => tx.createTask(task, null, { ownership: { kind: "conversation" }, background }),
		context,
	);
}

/** Drop the loaded trackers, so the next acquisition reads Storage on the line. */
function unloadDocuments(harness: Harness): Promise<void> {
	return (harness as unknown as SessionImpl).unloadDocuments();
}

function withSignal(signal: AbortSignal): Context {
	return { ...context, abortSignal: signal };
}

/** Whether a raw Storage read still succeeds, as code of a joined invocation relies on. */
async function storageOpen(storage: Storage): Promise<boolean> {
	return storage.task(1 as TaskId, context).then(
		() => true,
		() => false,
	);
}

/** Commit a conversation with a `running` task, as a crash leaves it, so open has a reconciliation commit to fail. */
async function seedRunningTask(storage: Storage): Promise<void> {
	const conversationId = await storage.mintId<ConversationId>();
	const id = await storage.mintId<TaskId<JsonValue>>();
	const state = { status: "running", checkpoint: { phase: "run" } } as const;
	const task = { id, conversationId, kind: "test.seeded", version: 1, input: null, background: false, state };
	await storage.commit(
		[
			{ type: "conversation", value: { id: conversationId } },
			{ type: "task", value: { ...task, abortRequested: false } },
		],
		context,
	);
}

describe("Harness open", () => {
	it("closes without a cancelled caller context and rethrows the original error when open fails", async () => {
		const storage = new ControlledStorage();
		await seedRunningTask(storage);
		const reader = countingReader(createRegistry());
		const held = storage.holdCommits();
		storage.failNextCommit(new Error("disk full"));
		const controller = new AbortController();
		const opening = Harness.open(
			storage,
			{ models: createModels(), registry: reader },
			withSignal(controller.signal),
		);
		await held.entered;
		controller.abort(new Error("caller gave up"));
		held.release();
		await expect(opening).rejects.toThrow("disk full");
		expect(reader.subscriptions()).toBe(0);
		expect(await storageOpen(storage)).toBe(false);
	});

	it("reports a failing close and still rethrows the open error", async () => {
		class FailingClose extends ControlledStorage {
			override async close(closeContext: Context): Promise<void> {
				await super.close(closeContext);
				throw new Error("close failed");
			}
		}
		const storage = new FailingClose();
		await seedRunningTask(storage);
		storage.failNextCommit(new Error("disk full"));
		const reports: unknown[] = [];
		const opening = Harness.open(
			storage,
			{ models: createModels(), registry: createRegistry(), onReport: (error) => reports.push(error) },
			context,
		);
		await expect(opening).rejects.toThrow("disk full");
		expect(reports).toEqual([new Error("close failed")]);
	});
});

describe("Harness close", () => {
	it("joins a task handler that ignores its signal before closing Storage", async () => {
		const storage = new MemoryStorage();
		const reached = deferred();
		const gate = deferred();
		let readAfterRelease: boolean | undefined;
		const Stubborn = oneStep("test.close-stubborn", async () => {
			reached.resolve();
			await gate.promise;
			readAfterRelease = await storageOpen(storage);
		});
		const { harness } = await openTasks(storage, [Stubborn]);
		await start(await harness.root(context), Stubborn);
		harness.resume();
		await reached.promise;
		const closing = harness.close(context);
		expect(await settled(closing)).toBe(false);
		expect(await storageOpen(storage)).toBe(true);
		gate.resolve();
		await closing;
		expect(readAfterRelease).toBe(true);
		expect(await storageOpen(storage)).toBe(false);
	});

	it("joins a tool execute and a hook that ignore their signal before closing Storage", async () => {
		for (const where of ["tool", "hook"] as const) {
			const setup = chatSetup();
			const storage = new MemoryStorage();
			const reached = deferred();
			const gate = deferred();
			let readAfterRelease: boolean | undefined;
			const stubborn = async (): Promise<void> => {
				reached.resolve();
				await gate.promise;
				readAfterRelease = await storageOpen(storage);
			};
			addTool(
				setup.registry,
				defineTool({
					name: "wait",
					description: "wait",
					parameters: Type.Object({}),
					execute: async () => {
						if (where === "tool") await stubborn();
						return { content: [] };
					},
				}),
			);
			addHooks(setup.registry, GenerationTask, {
				beforeRequest: async () => {
					if (where === "hook") await stubborn();
					return undefined;
				},
			});
			setup.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("wait", {}, { id: "c1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("done")]),
			]);
			const { harness, root } = await openChat(storage, setup);
			await root.submit({ type: "input", content: "go" }, context);
			await reached.promise;
			const closing = harness.close(context);
			expect(await settled(closing)).toBe(false);
			expect(await storageOpen(storage)).toBe(true);
			gate.resolve();
			await closing;
			expect(readAfterRelease).toBe(true);
			expect(await storageOpen(storage)).toBe(false);
		}
	});

	it("lets a new Harness open the same Storage once close resolved: no old invocation code runs", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-lifecycle-"));
		try {
			const path = join(directory, "session.sqlite");
			const log: string[] = [];
			const gate = deferred();
			let generation = 1;
			const Stubborn = oneStep("test.generations", async () => {
				const mine = generation;
				log.push(`start ${mine}`);
				if (mine === 1) await gate.promise;
				log.push(`end ${mine}`);
			});
			const first = await openTasks(await openNodeSqliteStorage(path), [Stubborn]);
			const id = await start(await first.harness.root(context), Stubborn);
			first.harness.resume();
			await eventually(() => log.length === 1);
			const closing = first.harness.close(context).then(() => void log.push("closed"));
			expect(await settled(closing)).toBe(false);
			gate.resolve();
			await closing;
			expect(log).toEqual(["start 1", "end 1", "closed"]);
			generation = 2;
			const second = await openTasks(await openNodeSqliteStorage(path), [Stubborn]);
			second.harness.resume();
			await second.harness.waitForTask(id, context);
			expect(log).toEqual(["start 1", "end 1", "closed", "start 2", "end 2"]);
			await second.harness.close(context);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("keeps shutting down after a cancelled close, and a second close awaits the same shutdown", async () => {
		const storage = new MemoryStorage();
		const reached = deferred();
		const gate = deferred();
		const Stubborn = oneStep("test.close-cancelled", async () => {
			reached.resolve();
			await gate.promise;
		});
		const { harness } = await openTasks(storage, [Stubborn]);
		await start(await harness.root(context), Stubborn);
		harness.resume();
		await reached.promise;
		const controller = new AbortController();
		const cancelled = harness.close(withSignal(controller.signal));
		controller.abort(new Error("stop waiting"));
		await expect(cancelled).rejects.toThrow("stop waiting");
		// Admission stays sealed and the invocation still holds Storage open.
		await expect(harness.commit(() => {}, context)).rejects.toThrow("closed");
		expect(await storageOpen(storage)).toBe(true);
		const second = harness.close(context);
		expect(await settled(second)).toBe(false);
		gate.resolve();
		await second;
		expect(await storageOpen(storage)).toBe(false);
	});

	it("settles durably a commit whose committer was cancelled while it was in Storage", async () => {
		const storage = new ControlledStorage();
		const { harness } = await openTasks(storage, []);
		const root = await harness.root(context);
		const held = storage.holdCommits();
		const controller = new AbortController();
		const committing = root.commit(
			(tx) => tx.appendEntry(root.id, { kind: "note" }).then((entry) => entry.id),
			withSignal(controller.signal),
		);
		await held.entered;
		controller.abort(new Error("committer gave up"));
		held.release();
		const id = await committing;
		const page = await root.entries({}, 10, undefined, context);
		expect(page.items.map((entry) => entry.id)).toEqual([id]);
		await harness.close(context);
	});

	it("publishes no frame to states and watches from a commit that settles during close", async () => {
		const Notes = defineDoc<{ text: string }>({
			kind: "test.close-frames",
			version: 1,
			scope: "session",
			initial: () => ({ text: "" }),
		});
		const storage = new ControlledStorage();
		const { harness } = await openTasks(storage, []);
		const root = await harness.root(context);
		await harness.commit(async (tx) => {
			(await tx.doc(Notes)).text = "before";
		}, context);
		const docState = (await harness.documentState(Notes, context))!;
		const docWatch = (await harness.watchDoc(Notes, context))!;
		const viewState = await root.viewState(context);
		const viewWatch = await root.watch(context);
		const graphState = await harness.taskGraph(context);
		const graphWatch = await harness.watchTaskGraph(context);
		const frames: string[] = [];
		graphState.subscribe((_value, _context, delivery) => {
			if (delivery.kind === "update") frames.push("graphState");
		});
		graphWatch.start(async () => void frames.push("graphWatch"));
		docState.subscribe((_value, _context, delivery) => {
			if (delivery.kind === "update") frames.push("docState");
		});
		viewState.subscribe((_value, _context, delivery) => {
			if (delivery.kind === "update") frames.push("viewState");
		});
		docWatch.start(async () => void frames.push("docWatch"));
		viewWatch.start(async () => void frames.push("viewWatch"));
		const docValue = docState.value;
		const viewValue = viewState.value;

		const held = storage.holdCommits();
		const committing = harness.commit(async (tx) => {
			(await tx.doc(Notes)).text = "during close";
			await tx.appendEntry(root.id, { kind: "note" });
			await tx.createTask(oneStep("test.close-graph"), null, {
				ownership: { kind: "conversation" },
				conversationId: root.id,
			});
		}, context);
		await held.entered;
		const closing = harness.close(context);
		held.release();
		await committing;
		await closing;
		await flush();
		expect(frames).toEqual([]);
		expect(docState.value).toBe(docValue);
		expect(viewState.value).toBe(viewValue);
		expect(graphState.value).toEqual({ tasks: {} });
		expect(await graphWatch.closed).toEqual({ reason: "session_closed" });
		expect(await docWatch.closed).toEqual({ reason: "session_closed" });
		expect(await viewWatch.closed).toEqual({ reason: "session_closed" });
		// The commit itself settled.
		expect(storage.commits.at(-1)).toContainEqual(expect.objectContaining({ type: "entry" }));
	});

	it("leaves no subscription behind a watch acquisition cancelled on the line", async () => {
		const Notes = defineDoc<{ text: string }>({
			kind: "test.cancelled-watch",
			version: 1,
			scope: "session",
			initial: () => ({ text: "" }),
		});
		const storage = new ControlledStorage();
		const { harness } = await openTasks(storage, []);
		const root = await harness.root(context);
		await harness.commit(async (tx) => {
			(await tx.doc(Notes)).text = "x";
		}, context);
		// Count commit subscriptions of document observers.
		let subscriptions = 0;
		const subscribe = harness.subscribeCommits.bind(harness);
		harness.subscribeCommits = (listener) => {
			subscriptions++;
			const unsubscribe = subscribe(listener);
			let active = true;
			return () => {
				if (active) subscriptions--;
				active = false;
				unsubscribe();
			};
		};

		// Cancel a document watch while its acquisition loads the document on the line.
		await unloadDocuments(harness);
		let find = storage.holdFindDocument();
		let controller = new AbortController();
		const docWatch = harness.watchDoc(Notes, withSignal(controller.signal));
		await find.entered;
		controller.abort(new Error("cancelled"));
		find.release();
		await expect(docWatch).rejects.toThrow("cancelled");
		expect(subscriptions).toBe(0);

		// Cancel a view watch while it builds its mount on the line.
		await unloadDocuments(harness);
		find = storage.holdFindDocument();
		controller = new AbortController();
		const viewWatch = root.watch(withSignal(controller.signal));
		await find.entered;
		controller.abort(new Error("cancelled"));
		find.release();
		await expect(viewWatch).rejects.toThrow("cancelled");
		// No observer kept the mount: the next observer builds a new one, and the one after that another.
		const first = await root.viewState(context);
		const firstValue = first.value;
		first.dispose();
		const second = await root.viewState(context);
		expect(second.value).not.toBe(firstValue);
		second.dispose();
		await harness.close(context);
	});

	it("rejects conversation and Harness operations once close begins; inspect queued before reports closing", async () => {
		const storage = new ControlledStorage();
		const { harness } = await openTasks(storage, []);
		const root = await harness.root(context);
		const entry = await root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context);
		const submission = await root.submit({ type: "write", entry: { kind: "note" } }, context);

		const held = storage.holdCommits();
		const blocking = harness.commit((tx) => tx.appendEntry(root.id, { kind: "blocker" }).then(() => {}), context);
		await held.entered;
		const queuedInspect = harness.inspect(context);
		const closing = harness.close(context);
		const operations: Record<string, () => Promise<unknown>> = {
			submit: () => root.submit({ type: "input", content: "x" }, context),
			agent: () => root.agent(context),
			configure: () => root.configure({ thinkingLevel: "low" }, context),
			commit: () => root.commit(() => {}, context),
			context: () => root.context(context),
			entries: () => root.entries({}, 10, undefined, context),
			fork: () => root.fork(entry.id, { ownership: { kind: "ownerless" } }, context),
			compact: () => root.compact(undefined, context),
			reset: () => root.reset(undefined, context),
			abort: () => root.abort(context),
			conversationIdle: () => root.waitForIdle(context),
			viewState: () => root.viewState(context),
			watch: () => root.watch(context),
			taskGraph: () => harness.taskGraph(context),
			watchTaskGraph: () => harness.watchTaskGraph(context),
			status: () => submission.status(context),
			wait: () => submission.wait(context),
			abortSubmission: () => submission.abort(context),
			root: () => harness.root(context),
			conversation: () => harness.conversation(root.id, context),
			createConversation: () => harness.createConversation({ ownership: { kind: "ownerless" } }, context),
			getTask: () => harness.getTask(1 as TaskId, context),
			inspect: () => harness.inspect(context),
			submission: () => harness.submission(submission.id, context),
			abortTask: () => harness.abortTask(1 as TaskId, context),
			waitForTask: () => harness.waitForTask(1 as TaskId, context),
			harnessIdle: () => harness.waitForIdle(context),
			usage: () => harness.usage(context),
		};
		const outcomes: Record<string, string> = {};
		for (const [name, operation] of Object.entries(operations)) {
			outcomes[name] = await operation().then(
				() => "resolved",
				(error: unknown) => (/closed/.test(String(error)) ? "closed" : String(error)),
			);
		}
		expect(outcomes).toEqual(Object.fromEntries(Object.keys(operations).map((name) => [name, "closed"])));
		expect(() => harness.resume()).toThrow("closed");
		held.release();
		await blocking;
		expect((await queuedInspect).scheduling).toBe("closing");
		await closing;
	});

	it("completes reads queued at the seal and rejects queued waits and acquisitions that would follow commits", async () => {
		const Notes = defineDoc<{ text: string }>({
			kind: "test.queued-at-seal",
			version: 1,
			scope: "session",
			initial: () => ({ text: "" }),
		});
		const Absent = defineDoc<{ text: string }>({
			kind: "test.queued-absent",
			version: 1,
			scope: "session",
			initial: () => ({ text: "" }),
		});
		const Pending = oneStep("test.queued-pending");
		const storage = new ControlledStorage();
		const { harness } = await openTasks(storage, []);
		const root = await harness.root(context);
		await harness.commit((tx) => tx.doc(Notes).then(() => {}), context);
		const taskId = await start(root, Pending);
		const write = await root.submit({ type: "write", entry: { kind: "note" } }, context);
		await write.wait(context);

		const held = storage.holdCommits();
		const blocking = harness.commit((tx) => tx.appendEntry(root.id, { kind: "blocker" }).then(() => {}), context);
		await held.entered;
		const settle = (promise: Promise<unknown>): Promise<string> =>
			promise.then(
				(value) => (value === undefined ? "undefined" : "resolved"),
				(error: unknown) => (/closed/.test(String(error)) ? "closed" : String(error)),
			);
		const queued = {
			context: settle(root.context(context)),
			snapshot: settle(harness.snapshot(Notes, context)),
			settledWait: settle(write.wait(context)),
			absentWatch: settle(harness.watchDoc(Absent, context)),
			absentState: settle(harness.documentState(Absent, context)),
			waitForTask: settle(harness.waitForTask(taskId, context)),
			documentState: settle(harness.documentState(Notes, context)),
			watchDoc: settle(harness.watchDoc(Notes, context)),
			viewState: settle(root.viewState(context)),
			watch: settle(root.watch(context)),
			taskGraph: settle(harness.taskGraph(context)),
		};
		const closing = harness.close(context);
		held.release();
		await blocking;
		const outcomes: Record<string, string> = {};
		for (const [name, outcome] of Object.entries(queued)) outcomes[name] = await outcome;
		expect(outcomes).toEqual({
			context: "resolved",
			snapshot: "resolved",
			settledWait: "resolved",
			absentWatch: "undefined",
			absentState: "undefined",
			waitForTask: "closed",
			documentState: "closed",
			watchDoc: "closed",
			viewState: "closed",
			watch: "closed",
			taskGraph: "closed",
		});
		await closing;
	});
});

describe("scheduling on a paused Harness", () => {
	/** Open a paused Harness with one background task pending and a queued write submission. */
	async function paused() {
		let ran = false;
		const Marker = oneStep("test.marker", async () => {
			ran = true;
		});
		const { harness } = await openTasks(new MemoryStorage(), [Marker]);
		const root = await harness.root(context);
		// Background, so idle waits and conversation abort leave it alone.
		const id = await start(root, Marker, true);
		const submissionId = await harness.commit(
			async (tx) => (await tx.createSubmission({ conversationId: root.id, type: "write", status: "queued" })).id,
			context,
		);
		return { harness, root, id, submissionId, ran: () => ran };
	}

	it("never schedules from a read-only viewer", async () => {
		const { harness, root, id, submissionId, ran } = await paused();
		const Notes = defineDoc<{ text: string }>({
			kind: "test.viewer-notes",
			version: 1,
			scope: "session",
			initial: () => ({ text: "" }),
		});
		await harness.commit((tx) => tx.doc(Notes).then(() => {}), context);
		await harness.inspect(context);
		await harness.getTask(id, context);
		await harness.usage(context);
		await harness.conversation(root.id, context);
		await harness.snapshot(Notes, context);
		(await harness.documentState(Notes, context))!.dispose();
		await (await harness.watchDoc(Notes, context))!.stop();
		const submission = (await harness.submission(submissionId, context))!;
		await submission.status(context);
		await root.agent(context);
		await root.context(context);
		await root.entries({}, 10, undefined, context);
		(await root.viewState(context)).dispose();
		await (await root.watch(context)).stop();
		(await harness.taskGraph(context)).dispose();
		await (await harness.watchTaskGraph(context)).stop();
		await flush();
		await flush();
		expect(ran()).toBe(false);
		expect((await harness.inspect(context)).scheduling).toBe("paused");
		await harness.close(context);
	});

	it("schedules from every progress call", async () => {
		const calls: Record<string, (opened: Awaited<ReturnType<typeof paused>>) => Promise<unknown>> = {
			submit: ({ root }) => root.submit({ type: "write", entry: { kind: "note" } }, context),
			compact: ({ root }) => root.compact(undefined, context),
			abort: ({ root }) => root.abort(context),
			conversationIdle: ({ root }) => root.waitForIdle(context),
			submissionWait: async ({ harness, submissionId }) =>
				(await harness.submission(submissionId, context))!.wait(context),
			waitForTask: ({ harness, id }) => harness.waitForTask(id, context),
			harnessIdle: ({ harness }) => harness.waitForIdle(context),
		};
		for (const [name, call] of Object.entries(calls)) {
			const opened = await paused();
			// A queued write's wait settles only on placement; close rejects it.
			const pending = call(opened).catch(() => {});
			await eventually(async () => opened.ran()).catch(() => {
				throw new Error(`${name} did not enable scheduling`);
			});
			await opened.harness.close(context);
			await pending;
		}
	});
});

describe("registry changes before resume", () => {
	it("runs what the registry holds at resume: a definition installed or replaced after open", async () => {
		const log: string[] = [];
		const define = (label: string) =>
			oneStep("test.late-definition", async () => {
				log.push(label);
			});
		const storage = new MemoryStorage();
		const first = await openTasks(storage, []);
		const root = await first.harness.root(context);
		const missing = await start(root, define("unused"));
		expect((await first.harness.inspect(context)).tasks).toMatchObject([
			{ state: { kind: "blocked", reason: "missing_task" } },
		]);
		const installed = addTask(first.registry, define("v1"));
		expect((await first.harness.inspect(context)).tasks).toMatchObject([{ state: { kind: "ready" } }]);
		// The same extension name replaces the definition in place, still before resume.
		installed.dispose();
		addTask(first.registry, define("v2"));
		first.harness.resume();
		await first.harness.waitForTask(missing, context);
		expect(log).toEqual(["v2"]);
		await first.harness.close(context);
	});
});
