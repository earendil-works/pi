// Gates before a tool runs (spec suspendable §5): `beforeTool` sleeps, the `call` phase asked again on every wake,
// registry changes and opens that wake parked calls, and the deadline path of such a wake.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineSignal,
	defineTool,
	type EntryRecord,
	type Harness,
	type HookRegistration,
	hook,
	LiveDoc,
	MemoryStorage,
	type Storage,
	type TaskId,
	ToolResultEntry,
	ToolTask,
} from "@earendil-works/pi-durable";
import { bool, obj, str } from "@earendil-works/pi-schema";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, type ChatSetup, chatSetup, openChat, waitFor } from "./chat-support.ts";
import { addTool } from "./harness-support.ts";
import { context } from "./session-support.ts";
import { deferred } from "./task-support.ts";

const Approval = defineSignal({ name: "test.approval", version: 1, schema: obj({ allow: bool() }) });
const DAY = 24 * 60 * 60 * 1000;

const directories = new Set<string>();

afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-gates-"));
	directories.add(directory);
	return join(directory, "session.sqlite");
}

function call(command = "rm -rf build"): AssistantMessage {
	return fauxAssistantMessage([fauxToolCall("bash", { command }, { id: "c1" })], { stopReason: "toolUse" });
}

const DONE = fauxAssistantMessage([fauxText("done")]);

function results(entries: readonly EntryRecord[]): ToolResultMessage[] {
	return entries.filter((entry) => ToolResultEntry.is(entry)).map((entry) => entry.model![0] as ToolResultMessage);
}

function text(message: ToolResultMessage | undefined): string {
	return (message?.content ?? []).map((item) => (item.type === "text" ? item.text : "")).join("|");
}

/** A `bash` stand-in that counts its runs. */
function bashTool(runs: { count: number }) {
	return defineTool({
		name: "bash",
		description: "bash",
		parameters: obj({ command: str() }),
		execute: async ({ command }) => {
			runs.count++;
			return { output: [{ type: "text", text: `ran ${command}` }] };
		},
	});
}

/** The approval gate of spec §5.1: sleeps on an approval keyed by the command, with a deadline fixed at its first pass. */
function approvals(passes: { count: number }): HookRegistration {
	return hook(ToolTask, {
		beforeTool: async (gated, api, ctx) => {
			passes.count++;
			const key = String((gated.arguments as { command: string }).command).replaceAll(" ", "_");
			const state = await api.readSignal(Approval, key, ctx);
			const until = await api.memo(`approvals.until.${key}`, api.now() + DAY, ctx);
			if (state === undefined) return { sleep: { signals: [Approval.key(key)], until } };
			if ("expired" in state) return { block: "No approval within a day" };
			return state.value.allow ? undefined : { block: "Not approved" };
		},
	});
}

async function open(setup: ChatSetup, storage: Storage = new MemoryStorage()) {
	const opened = await openChat(storage, setup);
	opened.harness.resume();
	return opened;
}

/** The task of the root's first tool slot, once it sleeps at its gates. */
async function gated(harness: Harness): Promise<TaskId> {
	let id: TaskId | undefined;
	await waitFor(async () => {
		const slot = (await harness.snapshot(LiveDoc, 1 as never, context))?.tools?.[0];
		id = slot?.taskId;
		return id !== undefined && slot?.status === "sleeping";
	});
	return id!;
}

describe("a beforeTool sleep", () => {
	it("parks the call before it runs, and runs it once approved", async () => {
		const setup = chatSetup();
		const runs = { count: 0 };
		const passes = { count: 0 };
		addTool(setup.registry, bashTool(runs));
		setup.registry.install(defineExtension({ name: "approvals", hooks: [approvals(passes)] }));
		setup.faux.setResponses([call(), DONE]);
		const { harness, root } = await open(setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		const id = await gated(harness);
		expect((await harness.getTask(id, context))?.state).toMatchObject({
			status: "sleeping",
			checkpoint: { phase: "call" },
			signals: [Approval.key("rm_-rf_build")],
		});
		await waitFor(() => !harness.wake().active);
		expect(runs.count).toBe(0);
		await harness.signal(id, Approval, "rm_-rf_build", { allow: true }, context);
		expect((await submission.wait(context)).status).toBe("done");
		expect(runs.count).toBe(1);
		expect(passes.count).toBe(2);
		expect(text(results(await allEntries(root))[0])).toBe("ran rm -rf build");
		await harness.close(context);
	});

	it("blocks on a denial, and on the deadline, after which a late answer is closed", async () => {
		for (const outcome of ["denied", "expired"] as const) {
			const setup = chatSetup();
			let offset = 0;
			setup.now = () => Date.now() + offset;
			const runs = { count: 0 };
			addTool(setup.registry, bashTool(runs));
			setup.registry.install(defineExtension({ name: "approvals", hooks: [approvals({ count: 0 })] }));
			setup.faux.setResponses([call(), DONE]);
			const { harness, root } = await open(setup);
			const submission = await root.submit({ type: "input", content: "go" }, context);
			const id = await gated(harness);
			if (outcome === "denied") await harness.signal(id, Approval, "rm_-rf_build", { allow: false }, context);
			else {
				offset = DAY;
				harness.resume();
			}
			expect((await submission.wait(context)).status).toBe("done");
			expect(runs.count).toBe(0);
			expect(text(results(await allEntries(root))[0])).toContain(
				outcome === "denied" ? "Not approved" : "No approval within a day",
			);
			if (outcome === "expired") {
				expect(await harness.signal(id, Approval, "rm_-rf_build", { allow: true }, context)).toBe("closed");
			}
			await harness.close(context);
		}
	});

	it("asks every gate again on each wake, in extension order, and stops at the first that sleeps", async () => {
		const setup = chatSetup();
		const runs = { count: 0 };
		const passes = { count: 0 };
		const quiet = { count: 0 };
		addTool(setup.registry, bashTool(runs));
		setup.registry.install(defineExtension({ name: "approvals", hooks: [approvals(passes)] }));
		setup.registry.install(
			defineExtension({
				name: "quiet-hours",
				hooks: [
					hook(ToolTask, {
						beforeTool: async () => {
							quiet.count++;
							return undefined;
						},
					}),
				],
			}),
		);
		setup.faux.setResponses([call(), DONE]);
		const { harness, root } = await open(setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		const id = await gated(harness);
		expect([passes.count, quiet.count]).toEqual([1, 0]);
		await harness.signal(id, Approval, "rm_-rf_build", { allow: true }, context);
		await submission.wait(context);
		expect([passes.count, quiet.count, runs.count]).toEqual([2, 1, 1]);
		await harness.close(context);
	});

	it("ends the call invalid_park when the sleep waits for nothing", async () => {
		const setup = chatSetup();
		const runs = { count: 0 };
		addTool(setup.registry, bashTool(runs));
		setup.registry.install(
			defineExtension({ name: "bad", hooks: [hook(ToolTask, { beforeTool: async () => ({ sleep: {} }) })] }),
		);
		setup.faux.setResponses([call(), DONE]);
		const { harness, root } = await open(setup);
		expect((await (await root.submit({ type: "input", content: "go" }, context)).wait(context)).status).toBe("done");
		expect(runs.count).toBe(0);
		expect(text(results(await allEntries(root))[0])).toContain("cannot wait at its gates");
		await harness.close(context);
	});
});

describe("registry changes and opens", () => {
	it("wake a call parked at its gates, so the gates installed then decide", async () => {
		const setup = chatSetup();
		const runs = { count: 0 };
		const passes = { count: 0 };
		addTool(setup.registry, bashTool(runs));
		const gate = defineExtension({ name: "approvals", hooks: [approvals(passes)] });
		setup.registry.install(gate);
		setup.faux.setResponses([call(), DONE]);
		const { harness, root } = await open(setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await gated(harness);
		// Another extension installed: asked again, and still asleep.
		setup.registry.install(defineExtension({ name: "other" }));
		await waitFor(() => passes.count === 2);
		// The gate uninstalled: the next pass runs the call.
		setup.registry.uninstall(gate);
		expect((await submission.wait(context)).status).toBe("done");
		expect([passes.count, runs.count]).toEqual([2, 1]);
		await harness.close(context);
	});

	it("wake a sleep committed under a snapshot a publication replaced while the gate ran", async () => {
		const setup = chatSetup();
		const passes = { count: 0 };
		const entered = deferred();
		const release = deferred();
		addTool(setup.registry, bashTool({ count: 0 }));
		setup.registry.install(
			defineExtension({
				name: "slow",
				hooks: [
					hook(ToolTask, {
						beforeTool: async () => {
							passes.count++;
							if (passes.count === 1) {
								entered.resolve();
								await release.promise;
							}
							return passes.count < 3 ? { sleep: { signals: [Approval.key(`k${passes.count}`)] } } : undefined;
						},
					}),
				],
			}),
		);
		setup.faux.setResponses([call(), DONE]);
		const { harness, root } = await open(setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await entered.promise;
		setup.registry.install(defineExtension({ name: "other" }));
		release.resolve();
		// The first sleep is woken at once; the second one waits for its key.
		const id = await gated(harness);
		await waitFor(() => passes.count === 2);
		await harness.signal(id, Approval, "k2", { allow: true }, context);
		expect((await submission.wait(context)).status).toBe("done");
		expect(passes.count).toBe(3);
		await harness.close(context);
	});

	it("wake a call parked at its gates at open, before its deadline, so a gate removed meanwhile lets it run", async () => {
		const path = await sqlitePath();
		const passes = { count: 0 };
		const runs = { count: 0 };
		const build = (withGate: boolean) => {
			const setup = chatSetup();
			addTool(setup.registry, bashTool(runs));
			if (withGate) setup.registry.install(defineExtension({ name: "approvals", hooks: [approvals(passes)] }));
			setup.faux.setResponses([call(), DONE]);
			return setup;
		};
		let opened = await open(build(true), await openNodeSqliteStorage(path));
		const submissionId = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		await gated(opened.harness);
		await opened.harness.close(context);
		// The next process installs no approvals: the call runs at open, no signal, no deadline.
		const setup = build(false);
		setup.faux.setResponses([DONE]);
		opened = await open(setup, await openNodeSqliteStorage(path));
		expect((await (await opened.harness.submission(submissionId, context))!.wait(context)).status).toBe("done");
		expect([passes.count, runs.count]).toEqual([1, 1]);
		await opened.harness.close(context);
	});

	it("leave a call parked in execute() alone", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		let runs = 0;
		addTool(
			setup.registry,
			defineTool({
				name: "bash",
				description: "bash",
				parameters: obj({ command: str() }),
				execute: async (_args, api) => {
					runs++;
					return api.wake === undefined ? { sleep: { signals: [Approval.key("done")] } } : { output: [] };
				},
			}),
		);
		setup.faux.setResponses([call(), DONE]);
		let opened = await open(setup, await openNodeSqliteStorage(path));
		await opened.root.submit({ type: "input", content: "go" }, context);
		const id = await gated(opened.harness);
		setup.registry.install(defineExtension({ name: "other" }));
		await opened.harness.close(context);
		opened = await open(setup, await openNodeSqliteStorage(path));
		await waitFor(() => !opened.harness.wake().active);
		expect((await opened.harness.getTask(id, context))?.state).toMatchObject({
			status: "sleeping",
			checkpoint: { phase: "parked" },
		});
		expect(runs).toBe(1);
		await opened.harness.close(context);
	});

	it("take the deadline path for a gate whose deadline passed, so its keys expire", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		let offset = 0;
		setup.now = () => Date.now() + offset;
		const passes = { count: 0 };
		const runs = { count: 0 };
		addTool(setup.registry, bashTool(runs));
		setup.registry.install(defineExtension({ name: "approvals", hooks: [approvals(passes)] }));
		setup.faux.setResponses([call(), DONE]);
		let opened = await openChat(await openNodeSqliteStorage(path), setup);
		opened.harness.resume();
		const submissionId = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		const id = await gated(opened.harness);
		await opened.harness.close(context);
		// Reopened after the deadline: the open's wake expires the key, and the gate blocks.
		offset = 2 * DAY;
		opened = await open(setup, await openNodeSqliteStorage(path));
		expect((await (await opened.harness.submission(submissionId, context))!.wait(context)).status).toBe("done");
		expect(passes.count).toBe(2);
		expect(runs.count).toBe(0);
		expect(text(results(await allEntries(opened.root))[0])).toContain("No approval within a day");
		expect(await opened.harness.signal(id, Approval, "rm_-rf_build", { allow: true }, context)).toBe("closed");
		await opened.harness.close(context);
	});
});
