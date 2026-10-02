import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	ConversationBusy,
	defineEntry,
	type EntryId,
	GenerationTask,
	LiveDoc,
	type SubmissionCreate,
	type SubmissionId,
	type SubmissionRecord,
	UserEntry,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionImpl } from "../src/session/session.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, chatSetup, openChat, unanswered } from "./chat-support.ts";
import { ControlledStorage, context } from "./session-support.ts";
import { deferred } from "./task-support.ts";

const directories = new Set<string>();

afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-submissions-"));
	directories.add(directory);
	return join(directory, "session.sqlite");
}

describe("submissions", () => {
	it("appends an idle write and settles it done without a turn", async () => {
		const { harness, root } = await openChat(new ControlledStorage(), chatSetup());
		const submission = await root.submit({ type: "write", entry: { kind: "note", data: { text: "x" } } }, context);
		const settled = await submission.wait(context);
		expect(settled).toEqual({
			id: submission.id,
			conversationId: root.id,
			type: "write",
			status: "done",
			entry: expect.any(Number),
		});
		const entries = await allEntries(root);
		expect(entries).toEqual([{ id: settled.entry, conversationId: root.id, kind: "note", data: { text: "x" } }]);
		expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
		const tasks = await harness.commit((tx) => tx.scanTasks({ conversationId: root.id }, 10), context);
		expect(tasks.items).toEqual([]);
		await harness.close(context);
	});

	it("places idle input, and rejects busy input with whenBusy reject without writing", async () => {
		const storage = new ControlledStorage();
		const setup = chatSetup();
		setup.now = () => 42;
		const busy = unanswered();
		setup.faux.setResponses([busy.step]);
		const { harness, root } = await openChat(storage, setup);
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		await busy.reached;
		const record = await submission.status(context);
		if (record.status !== "placed") throw new Error(`Unexpected ${record.status}`);
		const entry = await root.commit((tx) => tx.entry(UserEntry, record.entry), context);
		expect(entry?.model).toEqual([{ role: "user", content: "hi", timestamp: 42 }]);
		const live = await harness.snapshot(LiveDoc, root.id, context);
		expect(live?.run?.inputs).toEqual([submission.id]);
		expect((await harness.getTask(live!.run!.taskId, context))?.kind).toBe("pi.generation");

		const commits = storage.commits.length;
		const rejected = root.submit({ type: "input", content: "again", whenBusy: "reject" }, context);
		await expect(rejected).rejects.toBeInstanceOf(ConversationBusy);
		await expect(rejected).rejects.toMatchObject({ conversationId: root.id });
		expect(storage.commits.length).toBe(commits);
		await harness.close(context);
	});

	it("deduplicates request IDs per conversation before any write", async () => {
		const storage = new ControlledStorage();
		const setup = chatSetup();
		const busy = unanswered();
		setup.faux.setResponses([busy.step]);
		const { harness, root } = await openChat(storage, setup);
		const first = await root.submit({ type: "input", content: "hi", requestId: "r1" }, context);
		await busy.reached;
		const commits = storage.commits.length;
		// Deduplication runs before the busy check.
		const again = await root.submit({ type: "input", content: "different", requestId: "r1" }, context);
		expect(again.id).toBe(first.id);
		expect(storage.commits.length).toBe(commits);
		await expect(root.submit({ type: "write", entry: { kind: "note" }, requestId: "r1" }, context)).rejects.toThrow(
			"Request r1 already identifies a submission of type input",
		);
		expect(await first.status(context)).toMatchObject({ requestId: "r1", status: "placed" });

		const other = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		const write = await other.submit({ type: "write", entry: { kind: "note" }, requestId: "r1" }, context);
		expect(write.id).not.toBe(first.id);
		expect((await other.submit({ type: "write", entry: { kind: "note" }, requestId: "r1" }, context)).id).toBe(
			write.id,
		);
		await harness.close(context);
	});

	it("reports abort results and looks submissions up by conversation", async () => {
		const setup = chatSetup();
		const release = deferred();
		setup.faux.setResponses([
			async () => {
				await release.promise;
				return fauxAssistantMessage("answer");
			},
		]);
		const { harness, root } = await openChat(new ControlledStorage(), setup);
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		expect(await submission.abort(context)).toBe("already_placed");
		expect(await harness.abortSubmission(submission.id, context, root.id)).toBe("already_placed");
		const other = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		expect(await harness.abortSubmission(submission.id, context, other.id)).toBe("not_found");
		expect(await harness.abortSubmission(999_999 as SubmissionId, context)).toBe("not_found");
		expect(await harness.submission(999_999 as SubmissionId, context)).toBeUndefined();

		release.resolve();
		await submission.wait(context);
		expect(await submission.abort(context)).toBe("settled");
		expect(await harness.abortSubmission(submission.id, context)).toBe("settled");
		await harness.close(context);
	});

	it("cancels only a wait and rejects pending waits on close", async () => {
		const setup = chatSetup();
		setup.faux.setResponses([unanswered().step]);
		const { harness, root } = await openChat(new ControlledStorage(), setup);
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		const controller = new AbortController();
		const cancelled = submission.wait({ ...context, abortSignal: controller.signal });
		const pending = submission.wait(context);
		controller.abort(new Error("stop waiting"));
		await expect(cancelled).rejects.toThrow("stop waiting");
		expect((await submission.status(context)).status).toBe("placed");
		await harness.close(context);
		await expect(pending).rejects.toThrow("Harness is closed");
	});

	it("rejects a wait whose submission read spans the start of close", async () => {
		const entered = deferred();
		const release = deferred();
		let hold = false;
		class HeldReads extends ControlledStorage {
			override async submission(
				id: SubmissionId,
				callContext: typeof context,
			): Promise<SubmissionRecord | undefined> {
				if (hold) {
					entered.resolve();
					await release.promise;
				}
				return super.submission(id, callContext);
			}
		}
		const setup = chatSetup();
		setup.faux.setResponses([unanswered().step]);
		const { harness, root } = await openChat(new HeldReads(), setup);
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		hold = true;
		const waiting = submission.wait(context);
		await entered.promise;
		const closing = harness.close(context);
		release.resolve();
		await expect(waiting).rejects.toThrow("Harness is closed");
		await closing;
	});

	it("reacquires a submission after reopen and settles it durably", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		// The first process never answers; the reopened one does.
		const busy = unanswered();
		setup.faux.setResponses([busy.step, fauxAssistantMessage("after reopen")]);
		let opened = await openChat(await openNodeSqliteStorage(path), setup);
		const id = (await opened.root.submit({ type: "input", content: "hi", requestId: "print" }, context)).id;
		await busy.reached;
		await opened.harness.close(context);

		opened = await openChat(await openNodeSqliteStorage(path), setup);
		const submission = (await opened.harness.submission(id, context))!;
		expect((await submission.status(context)).status).toBe("placed");
		opened.harness.resume();
		const settled = await submission.wait(context);
		if (settled.status !== "done" || settled.type !== "input") throw new Error(`Unexpected ${settled.status}`);
		await opened.harness.close(context);

		opened = await openChat(await openNodeSqliteStorage(path), setup);
		expect(await (await opened.harness.submission(id, context))!.wait(context)).toEqual(settled);
		const again = await opened.root.submit({ type: "input", content: "hi", requestId: "print" }, context);
		expect(again.id).toBe(id);
		await opened.harness.close(context);
	});

	it("enables scheduling when a caller submits or waits", async () => {
		const setup = chatSetup();
		setup.faux.setResponses([fauxAssistantMessage("answer")]);
		const { harness, root } = await openChat(new ControlledStorage(), setup);
		// No resume(): submitting asks for progress.
		expect((await (await root.submit({ type: "input", content: "hi" }, context)).wait(context)).status).toBe("done");
		await harness.close(context);

		const passive = await openChat(new ControlledStorage(), chatSetup());
		const taskId = await passive.root.commit(
			(tx) => tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" } }),
			context,
		);
		// A committed task alone does not start scheduling; waiting for it does.
		expect((await passive.harness.getTask(taskId, context))?.state.status).toBe("pending");
		expect((await passive.harness.waitForTask(taskId, context)).state.status).toBe("terminal");
		await passive.harness.close(context);
	});

	it("settles submissions by their current record in the transaction", async () => {
		const { harness, root } = await openChat(new ControlledStorage(), chatSetup());
		const session = harness as unknown as SessionImpl;
		const entry = await root.commit(async (tx) => (await tx.appendEntry(root.id, { kind: "note" })).id, context);
		const create = (record: SubmissionCreate) =>
			session.commitWith(async (tx) => (await tx.createSubmission(record)).id, context);
		const queued = await create({ conversationId: root.id, type: "input", status: "queued" });
		const write = await create({ conversationId: root.id, type: "write", status: "queued" });
		const answer = { status: "done", answer: entry } as const;
		await expect(root.commit((tx) => tx.settleSubmission(queued, answer), context)).rejects.toThrow(
			"is not a placed input",
		);
		await expect(root.commit((tx) => tx.settleSubmission(write, answer), context)).rejects.toThrow(
			"is not a placed input",
		);
		await expect(
			root.commit(
				(tx) => tx.settleSubmission(999_999 as SubmissionId, { status: "unanswered", reason: "x" }),
				context,
			),
		).rejects.toThrow("does not exist");

		// A submission created earlier in the same commit settles; a second settlement leaves the first.
		const placed = await session.commitWith(async (tx) => {
			const { id } = await tx.createSubmission({ conversationId: root.id, type: "input", status: "placed", entry });
			tx.settleSubmission(id, answer);
			tx.settleSubmission(id, { status: "unanswered", reason: "late" });
			return id;
		}, context);
		expect(await (await harness.submission(placed, context))!.status(context)).toMatchObject({
			status: "done",
			entry,
			answer: entry,
		});
		await harness.close(context);
	});

	it("appends and reads typed entries through tokens", async () => {
		const Counter = defineEntry<{ n: number }>("app.counter");
		const Marker = defineEntry("app.marker");
		const { harness, root } = await openChat(new ControlledStorage(), chatSetup());
		const counter = await root.commit((tx) => tx.appendEntry(Counter, root.id, { data: { n: 1 } }), context);
		const n: number = counter.data.n;
		expect(n).toBe(1);
		expect(counter).toEqual({ id: counter.id, conversationId: root.id, kind: "app.counter", data: { n: 1 } });
		const marker = await root.commit((tx) => tx.appendEntry(Marker, root.id, {}), context);
		expect(marker.kind).toBe("app.marker");
		expect(await root.commit((tx) => tx.entry(Counter, counter.id), context)).toEqual(counter);
		expect(await root.commit((tx) => tx.entry(Marker, counter.id), context)).toBeUndefined();
		expect(await root.commit((tx) => tx.entry(Counter, 999_999 as EntryId), context)).toBeUndefined();
		expect(Counter.is(counter)).toBe(true);
		expect(AssistantEntry.is(counter)).toBe(false);
		expect([UserEntry.kind, AssistantEntry.kind]).toEqual(["pi.user", "pi.assistant"]);
		await harness.close(context);
	});
});
