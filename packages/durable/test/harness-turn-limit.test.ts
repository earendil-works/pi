// Per-conversation turn limits (`AgentState.maxTurns`) and continuing a run that reached one (#11043).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, fauxAssistantMessage, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
	type AfterFailedRun,
	type Conversation,
	defineTool,
	GenerationTask,
	LiveDoc,
	MemoryStorage,
	ResetEntry,
	type Storage,
	type ToolRegistration,
	ToolResultEntry,
	ToolTask,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, type ChatSetup, chatSetup, openChat, textOf } from "./chat-support.ts";
import { addHooks, addTool } from "./harness-support.ts";
import { context } from "./session-support.ts";
import { aborted, deferred } from "./task-support.ts";

const directories = new Set<string>();
const killed = new Set<Storage>();

afterEach(async () => {
	for (const storage of killed) await storage.close(context).catch(() => {});
	killed.clear();
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

const Parameters = Type.Object({});

function tool(
	name: string,
	execute: ToolRegistration<typeof Parameters>["execute"],
): ToolRegistration<typeof Parameters> {
	return defineTool({ name, description: name, parameters: Parameters, execute });
}

/** A tool-calling answer with one `noop` call. */
function round(id: string): AssistantMessage {
	return fauxAssistantMessage([fauxToolCall("noop", {}, { id })], { stopReason: "toolUse" });
}

const DONE = fauxAssistantMessage([fauxText("done")]);

/** A chat with a `noop` tool and the given turn limit. */
async function limited(maxTurns: number | undefined, configure?: (setup: ChatSetup) => void) {
	const setup = chatSetup();
	addTool(
		setup.registry,
		tool("noop", async () => ({ output: [] })),
	);
	configure?.(setup);
	const opened = await openChat(new MemoryStorage(), setup);
	if (maxTurns !== undefined) await opened.root.configure({ maxTurns }, context);
	return { setup, ...opened };
}

async function lastKind(root: Conversation): Promise<string | undefined> {
	return (await allEntries(root)).at(-1)?.kind;
}

describe("turn limit", () => {
	// #11043
	it("ends a run after the tool round that reaches the limit, like a failure", async () => {
		const { setup, harness, root } = await limited(1);
		setup.faux.setResponses([round("c1"), DONE]);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		expect(await submission.wait(context)).toMatchObject({
			status: "unanswered",
			reason: "turn_limit",
			detail: "1 turn",
		});
		expect(setup.faux.state.callCount).toBe(1);
		// The transcript ends with the round's results; the generation completed, so nothing is reported.
		expect(await lastKind(root)).toBe(ToolResultEntry.kind);
		expect((await harness.snapshot(LiveDoc, root.id, context))?.runFailure).toMatchObject({
			reason: "turn_limit",
			inputs: [submission.id],
		});
		const generations = await harness.commit((tx) => tx.scanTasks({ conversationId: root.id }, 20), context);
		const generation = generations.items.find((task) => task.kind === GenerationTask.definition.name);
		expect(generation?.state).toMatchObject({ status: "terminal", outcome: { status: "completed" } });
		expect(setup.reports).toEqual([]);
		await harness.close(context);
	});

	// #11043
	it("counts tool rounds only: a run answers below its limit, and an answer at the limit settles done", async () => {
		const { setup, harness, root } = await limited(2);
		setup.faux.setResponses([round("c1"), DONE, round("c2"), round("c3"), DONE]);
		expect((await (await root.submit({ type: "input", content: "one" }, context)).wait(context)).status).toBe("done");
		// A new run starts with a fresh budget.
		const second = await (await root.submit({ type: "input", content: "two" }, context)).wait(context);
		expect(second).toMatchObject({ status: "unanswered", reason: "turn_limit", detail: "2 turns" });
		await harness.close(context);
	});

	// #11043
	it("runs onYield at the limit, and a continuation starts the count over", async () => {
		let yields = 0;
		const { setup, harness, root } = await limited(2, (chat) =>
			addHooks(chat.registry, GenerationTask, {
				onYield: () => (yields++ === 0 ? { continue: "keep going" } : undefined),
			}),
		);
		// Round (1 turn), answer: the continuation resets the count; then two rounds reach the limit.
		setup.faux.setResponses([round("c1"), DONE, round("c2"), round("c3"), DONE]);
		const settled = await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(settled).toMatchObject({ status: "unanswered", reason: "turn_limit" });
		expect(yields).toBe(1);
		expect(setup.faux.state.callCount).toBe(4);
		await harness.close(context);
	});

	// #11043
	it("settles a steer that joined the run at an earlier round with turn_limit too", async () => {
		const gate = deferred();
		const started = deferred();
		const setup = chatSetup();
		let calls = 0;
		addTool(
			setup.registry,
			tool("noop", async () => {
				if (calls++ === 0) {
					started.resolve();
					await gate.promise;
				}
				return { output: [] };
			}),
		);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await root.configure({ maxTurns: 2 }, context);
		setup.faux.setResponses([round("c1"), round("c2"), DONE]);
		const first = await root.submit({ type: "input", content: "go" }, context);
		await started.promise;
		const steer = await root.submit({ type: "input", content: "also this", whenBusy: "steer" }, context);
		gate.resolve();
		for (const submission of [first, steer]) {
			expect(await submission.wait(context)).toMatchObject({
				status: "unanswered",
				reason: "turn_limit",
				detail: "2 turns",
			});
		}
		expect((await harness.snapshot(LiveDoc, root.id, context))?.runFailure?.inputs).toEqual([first.id, steer.id]);
		expect(setup.faux.state.callCount).toBe(2);
		await harness.close(context);
	});

	// #11043
	it("leaves items queued during the last round to afterFailedRun", async () => {
		for (const policy of ["keep", "continue", "withdraw"] as const satisfies readonly AfterFailedRun[]) {
			const gate = deferred();
			const started = deferred();
			const setup = chatSetup();
			setup.settings.afterFailedRun = policy;
			addTool(
				setup.registry,
				tool("noop", async () => {
					started.resolve();
					await gate.promise;
					return { output: [] };
				}),
			);
			setup.faux.setResponses([round("c1"), DONE]);
			const { harness, root } = await openChat(new MemoryStorage(), setup);
			await root.configure({ maxTurns: 1 }, context);
			const first = await root.submit({ type: "input", content: "go" }, context);
			await started.promise;
			const steer = await root.submit({ type: "input", content: "also", whenBusy: "followUp" }, context);
			gate.resolve();
			expect((await first.wait(context)).status).toBe("unanswered");
			await harness.waitForIdle(context);
			const queued = await steer.status(context);
			if (policy === "keep") expect(queued.status).toBe("queued");
			if (policy === "continue") expect(queued.status).toBe("done");
			if (policy === "withdraw") expect(queued).toMatchObject({ status: "unanswered", reason: "run_failed" });
			await harness.close(context);
		}
	});

	// #11043
	it("applies a changed limit at the end of the round; null removes it", async () => {
		const setup = chatSetup();
		let root!: Conversation;
		let rounds = 0;
		addTool(
			setup.registry,
			tool("noop", async () => {
				rounds++;
				// Lowered during the second round: that round ends the run.
				if (rounds === 2) await root.configure({ maxTurns: 1 }, context);
				return { output: [] };
			}),
		);
		setup.faux.setResponses([round("c1"), round("c2"), round("c3"), DONE]);
		const opened = await openChat(new MemoryStorage(), setup);
		root = opened.root;
		await root.configure({ maxTurns: 5 }, context);
		const settled = await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(settled).toMatchObject({ status: "unanswered", reason: "turn_limit", detail: "2 turns" });
		await root.configure({ maxTurns: null }, context);
		expect((await root.agent(context)).maxTurns).toBeUndefined();
		setup.faux.setResponses([round("c4"), round("c5"), DONE]);
		expect((await (await root.submit({ type: "input", content: "again" }, context)).wait(context)).status).toBe(
			"done",
		);
		await opened.harness.close(context);
	});

	// #11043
	it("rejects a limit that is not an integer 1 or more", async () => {
		const { harness, root } = await limited(undefined);
		for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			await expect(root.configure({ maxTurns: value }, context)).rejects.toBeInstanceOf(RangeError);
		}
		await root.configure({ maxTurns: 3 }, context);
		expect((await root.agent(context)).maxTurns).toBe(3);
		await harness.close(context);
	});

	// #11043
	it("lets terminate settle done at the limit, and writes a handoff's reset before ending", async () => {
		const { setup, harness, root } = await limited(1, (chat) =>
			addHooks(chat.registry, ToolTask, {
				afterTool: (call, result) =>
					call.id === "t"
						? { ...result, control: { terminate: true } }
						: { ...result, control: { handoff: "fresh" } },
			}),
		);
		setup.faux.setResponses([round("t"), round("h"), DONE]);
		expect((await (await root.submit({ type: "input", content: "one" }, context)).wait(context)).status).toBe("done");
		const handedOff = await (await root.submit({ type: "input", content: "two" }, context)).wait(context);
		expect(handedOff).toMatchObject({ status: "unanswered", reason: "turn_limit" });
		const resets = (await allEntries(root)).filter((entry) => ResetEntry.is(entry));
		expect(resets.map((entry) => (entry.model?.[0] as { content: string }).content)).toEqual(["fresh"]);
		await harness.close(context);
	});

	// #11043
	it("is resumed by a continue, with a fresh budget, on the round's results", async () => {
		const { setup, harness, root } = await limited(1);
		let continued: string | undefined;
		setup.faux.setResponses([
			round("c1"),
			(request) => {
				continued = request.messages.at(-1)?.role;
				return fauxAssistantMessage([fauxText("finished")]);
			},
		]);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		const resumed = await root.submit({ type: "continue" }, context);
		expect((await harness.snapshot(LiveDoc, root.id, context))?.run?.turns).toBe(0);
		const settled = await resumed.wait(context);
		if (settled.status !== "done" || settled.type === "write") throw new Error(`Unexpected ${settled.status}`);
		const answer = (await allEntries(root)).find((entry) => entry.id === settled.answer);
		expect(textOf(answer?.model?.[0])).toBe("finished");
		expect(continued).toBe("toolResult");
		await harness.close(context);
	});

	// #11043
	it("is inherited by forks and children, which may set their own", async () => {
		const setup = chatSetup();
		let child: number | undefined;
		addTool(
			setup.registry,
			tool("spawn", async (_args, api, callContext) => {
				child = await api.commit(
					async (tx) => (await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } })).id,
					callContext,
				);
				return { output: [] };
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("spawn", {}, { id: "c1" })], { stopReason: "toolUse" }),
			DONE,
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await root.configure({ maxTurns: 4 }, context);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		const spawned = await harness.conversation(child as never, context);
		expect((await spawned!.agent(context)).maxTurns).toBe(4);
		const at = (await allEntries(root)).at(-1)!.id;
		const fork = await root.fork(at, { ownership: { kind: "ownerless" } }, context);
		expect((await fork.agent(context)).maxTurns).toBe(4);
		const own = await harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { maxTurns: 2 } },
			context,
		);
		expect((await own.agent(context)).maxTurns).toBe(2);
		await harness.close(context);
	});

	// #11043
	it("keeps the stored count across a restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-turns-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		const setup = chatSetup();
		setup.settings.progress = { outputIntervalMs: 0, persistWithinMs: 0 };
		const started = deferred();
		let runs = 0;
		addTool(
			setup.registry,
			defineTool({
				name: "noop",
				description: "noop",
				parameters: Parameters,
				replay: "safe",
				execute: async (_args, _api, callContext) => {
					runs++;
					if (runs === 2) {
						started.resolve();
						return aborted(callContext.abortSignal!);
					}
					return { output: [] };
				},
			}),
		);
		setup.faux.setResponses([round("c1"), round("c2"), DONE]);
		const inner = await openNodeSqliteStorage(path);
		let dead = false;
		const storage = new Proxy(inner, {
			get(target, property) {
				const value = Reflect.get(target, property, target);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => (dead ? new Promise(() => {}) : value.apply(target, args));
			},
		});
		const first = await openChat(storage, setup);
		await first.root.configure({ maxTurns: 2 }, context);
		const id = (await first.root.submit({ type: "input", content: "go" }, context)).id;
		await started.promise;
		expect((await first.harness.snapshot(LiveDoc, first.root.id, context))?.run?.turns).toBe(2);
		dead = true;
		killed.add(inner);

		// The replay-safe call runs again after reopen; the stored count still ends the run at this round.
		runs = 0;
		const second = await openChat(await openNodeSqliteStorage(path), setup);
		second.harness.resume();
		expect((await second.harness.snapshot(LiveDoc, second.root.id, context))?.run?.turns).toBe(2);
		const settled = await (await second.harness.submission(id, context))!.wait(context);
		expect(settled).toMatchObject({ status: "unanswered", reason: "turn_limit", detail: "2 turns" });
		await second.harness.close(context);
	});
});
