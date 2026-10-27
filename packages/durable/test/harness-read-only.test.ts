// A read-only Harness: a viewer of a session another process drives, such as a synced copy on another device.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Harness, LiveDoc, ReadOnlySession, UserEntry, type Wake } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, type ChatSetup, chatSetup, openChat, unanswered } from "./chat-support.ts";
import { context } from "./session-support.ts";

const directories = new Set<string>();

afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-read-only-"));
	directories.add(directory);
	return join(directory, "session.sqlite");
}

async function openReadOnly(path: string, setup: ChatSetup, onWake?: (wake: Wake) => void): Promise<Harness> {
	return Harness.open(
		await openNodeSqliteStorage(path),
		{
			models: setup.models,
			registry: setup.registry,
			readOnly: true,
			onReport: (error) => setup.reports.push(error),
			...(onWake === undefined ? {} : { onWake }),
		},
		context,
	);
}

/** The next sequence the file would commit, read beside every open handle; `undefined` before the schema exists. */
function head(path: string): number | undefined {
	const db = new DatabaseSync(path);
	try {
		const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'durable_metadata'").get();
		if (exists === undefined) return undefined;
		return Number(db.prepare("SELECT next_seq FROM durable_metadata WHERE singleton = 1").get()?.next_seq);
	} finally {
		db.close();
	}
}

/** A session whose root generation is running in another Harness, still open, waiting for the model. */
async function runningSession(path: string, setup: ChatSetup) {
	const busy = unanswered();
	setup.faux.setResponses([busy.step]);
	const driver = await openChat(await openNodeSqliteStorage(path), setup);
	await driver.root.submit({ type: "input", content: "slow" }, context);
	await busy.reached;
	return driver;
}

describe("read-only Harness", () => {
	it("opens a session with work running elsewhere without writing", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		const driver = await runningSession(path, setup);
		const before = head(path);
		const wakes: Wake[] = [];

		const viewer = await openReadOnly(path, chatSetup(), (wake) => wakes.push(wake));
		const root = await viewer.root(context);
		expect((await allEntries(root)).map((entry) => entry.kind)).toEqual([UserEntry.kind]);
		const run = (await viewer.snapshot(LiveDoc, root.id, context))?.run;
		expect(run).toBeDefined();
		expect((await viewer.getTask(run!.taskId, context))?.state.status).toBe("running");
		const inspection = await viewer.inspect(context);
		expect(inspection.scheduling).toBe("paused");
		expect(viewer.wake()).toEqual({ active: false });
		await viewer.close(context);

		expect(head(path)).toBe(before);
		expect(wakes).toEqual([]);
		await driver.harness.close(context);
	});

	it("refuses writes and scheduling, and stays usable", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		setup.faux.setResponses([fauxAssistantMessage("one")]);
		const driver = await openChat(await openNodeSqliteStorage(path), setup);
		await (await driver.root.submit({ type: "input", content: "hi" }, context)).wait(context);
		await driver.harness.close(context);
		const before = head(path);

		const viewerSetup = chatSetup();
		const viewer = await openReadOnly(path, viewerSetup);
		const root = await viewer.root(context);
		await expect(root.commit((tx) => tx.appendEntry(root.id, { kind: "app.note" }), context)).rejects.toBeInstanceOf(
			ReadOnlySession,
		);
		await expect(root.submit({ type: "input", content: "again" }, context)).rejects.toBeInstanceOf(ReadOnlySession);
		expect(() => viewer.resume()).toThrow(ReadOnlySession);
		await expect(viewer.waitForIdle(context)).rejects.toBeInstanceOf(ReadOnlySession);
		await expect(root.abort(context)).rejects.toBeInstanceOf(ReadOnlySession);
		await expect(viewer.createConversation({ ownership: { kind: "ownerless" } }, context)).rejects.toBeInstanceOf(
			ReadOnlySession,
		);

		// Still healthy: reads work, and a commit that writes nothing succeeds.
		expect(await root.commit(() => "nothing", context)).toBe("nothing");
		expect((await allEntries(root)).length).toBe(2);
		await viewer.close(context);
		expect(head(path)).toBe(before);
		expect(viewerSetup.reports).toEqual([]);
	});

	it("refuses to create the root of an empty storage", async () => {
		const path = await sqlitePath();
		const viewer = await openReadOnly(path, chatSetup());
		await expect(
			viewer.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } }),
		).rejects.toBeInstanceOf(ReadOnlySession);
		await viewer.close(context);
		expect(head(path)).toBe(1);
	});

	it("leaves recovery to the next writable open", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		const driver = await runningSession(path, setup);
		const taskId = (await driver.harness.snapshot(LiveDoc, driver.root.id, context))!.run!.taskId;

		const viewer = await openReadOnly(path, chatSetup());
		await viewer.close(context);

		// The writable open recovers the task once, as if the viewer had never opened it.
		const writer = await openChat(await openNodeSqliteStorage(path), chatSetup());
		const record = await writer.harness.getTask(taskId, context);
		expect(record?.state.status).toBe("pending");
		expect(record?.restarts).toBe(1);
		await writer.harness.close(context);
		await driver.harness.close(context);
	});
});
