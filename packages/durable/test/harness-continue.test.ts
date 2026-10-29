// `submit({ type: "continue" })`: a run without a new user message (#11043).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTelemetry } from "@earendil-works/chord/context";
import {
	type AssistantMessage,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type Message,
	Type,
} from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type Conversation,
	ConversationBusy,
	configure,
	defineTool,
	Harness,
	InboxDoc,
	LiveDoc,
	MemoryStorage,
	type SettledSubmissionRecord,
	type Storage,
	UserEntry,
} from "@earendil-works/pi-durable";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, type ChatSetup, chatSetup, openChat, textOf, unanswered, waitFor } from "./chat-support.ts";
import { addTool } from "./harness-support.ts";
import { context } from "./session-support.ts";
import { aborted, deferred } from "./task-support.ts";

const directories = new Set<string>();
/** Storages of killed Harnesses, never closed by them: closed after each test. */
const killed = new Set<Storage>();

afterEach(async () => {
	for (const storage of killed) await storage.close(context).catch(() => {});
	killed.clear();
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-continue-"));
	directories.add(directory);
	return join(directory, "session.sqlite");
}

/** Open a chat over the SQLite file at `path` and start scheduling; `kill()` simulates a crash. */
async function open(path: string, setup: ChatSetup) {
	const inner = await openNodeSqliteStorage(path);
	let dead = false;
	const storage = new Proxy(inner, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => (dead ? new Promise(() => {}) : value.apply(target, args));
		},
	});
	const opened = await openChat(storage, setup);
	opened.harness.resume();
	const kill = (): void => {
		dead = true;
		killed.add(inner);
	};
	return { ...opened, kill };
}

const failure = (): AssistantMessage =>
	fauxAssistantMessage([], { stopReason: "error", errorMessage: "Invalid request" });

/** A response step that records the roles of the context it was asked with, then answers `text`. */
function answering(text: string, seen: Message["role"][][]): FauxResponseStep {
	return (request) => {
		seen.push(request.messages.map((message) => message.role));
		return fauxAssistantMessage([fauxText(text)]);
	};
}

async function answerText(root: Conversation, settled: SettledSubmissionRecord): Promise<string | undefined> {
	if (settled.status !== "done" || settled.type === "write") throw new Error(`Unexpected ${settled.status}`);
	const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	return textOf(answer?.model?.[0]);
}

async function userEntries(root: Conversation): Promise<number> {
	return (await allEntries(root)).filter((entry) => UserEntry.is(entry)).length;
}

describe("continue", () => {
	// #11043
	it("answers a run that failed, without a new user message", async () => {
		const setup = chatSetup();
		const seen: Message["role"][][] = [];
		setup.faux.setResponses([failure, answering("recovered", seen)]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const first = await root.submit({ type: "input", content: "Analyze this" }, context);
		expect(await first.wait(context)).toMatchObject({ status: "unanswered", reason: "model_error" });
		expect((await harness.snapshot(LiveDoc, root.id, context))?.runFailure?.reason).toBe("model_error");

		const resumed = await root.submit({ type: "continue" }, context);
		expect((await resumed.status(context)).status).toBe("placed");
		const settled = await resumed.wait(context);
		expect(settled.type).toBe("continue");
		expect(await answerText(root, settled)).toBe("recovered");
		expect(seen.at(-1)?.at(-1)).toBe("user");
		// The failed input stays unanswered; no user entry was added.
		expect(await first.status(context)).toMatchObject({ status: "unanswered" });
		expect(await userEntries(root)).toBe(1);
		expect((await harness.snapshot(LiveDoc, root.id, context))?.runFailure).toBeUndefined();
		await harness.close(context);
	});

	// #11043
	it("answers the tool results of a round aborted midway", async () => {
		const setup = chatSetup();
		const started = deferred();
		addTool(
			setup.registry,
			defineTool({
				name: "wait",
				description: "Waits until aborted",
				parameters: Type.Object({}),
				execute: async (_args, _api, callContext) => {
					started.resolve();
					return aborted(callContext.abortSignal!);
				},
			}),
		);
		const seen: Message["role"][][] = [];
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {}, { id: "c1" })], { stopReason: "toolUse" }),
			answering("after the abort", seen),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const first = await root.submit({ type: "input", content: "go" }, context);
		await started.promise;
		await root.abort(context);
		expect(await first.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		const settled = await (await root.submit({ type: "continue" }, context)).wait(context);
		expect(await answerText(root, settled)).toBe("after the abort");
		expect(seen.at(-1)?.at(-1)).toBe("toolResult");
		await harness.close(context);
	});

	// #11043
	it("skips system messages when deciding there is something to answer", async () => {
		const setup = chatSetup();
		const seen: Message["role"][][] = [];
		setup.faux.setResponses([fauxAssistantMessage("first answer"), failure, answering("resumed", seen)]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await root.configure({ instructions: "Be thorough." }, context);
		await (await root.submit({ type: "input", content: "one" }, context)).wait(context);
		// Changed instructions append a system delta after the next user message, before its request.
		await root.configure({ instructions: "Be brief." }, context);
		const second = await root.submit({ type: "input", content: "two" }, context);
		expect(await second.wait(context)).toMatchObject({ status: "unanswered", reason: "model_error" });
		const roles = (await root.context(context)).messages.map((message) => message.role);
		expect(roles.at(-1)).toBe("system");
		const settled = await (await root.submit({ type: "continue" }, context)).wait(context);
		expect(await answerText(root, settled)).toBe("resumed");
		await harness.close(context);
	});

	// #11043
	it("is rejected while busy, after request ID deduplication", async () => {
		const setup = chatSetup();
		const busy = unanswered();
		setup.faux.setResponses([failure, busy.step]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		const resumed = await root.submit({ type: "continue", requestId: "resume-1" }, context);
		await busy.reached;
		await expect(root.submit({ type: "continue" }, context)).rejects.toBeInstanceOf(ConversationBusy);
		// The same request ID returns the existing submission instead of rejecting.
		expect((await root.submit({ type: "continue", requestId: "resume-1" }, context)).id).toBe(resumed.id);
		await harness.close(context);
	});

	// #11043
	it("ends without a request when there is nothing to answer", async () => {
		const setup = chatSetup();
		setup.faux.setResponses([fauxAssistantMessage("answered")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const empty = await (await root.submit({ type: "continue" }, context)).wait(context);
		expect(empty).toMatchObject({ type: "continue", status: "unanswered", reason: "nothing_to_answer" });
		await (await root.submit({ type: "input", content: "hi" }, context)).wait(context);
		const calls = setup.faux.state.callCount;
		// A context ending in an answer has nothing to continue.
		const after = await (await root.submit({ type: "continue" }, context)).wait(context);
		expect(after).toMatchObject({ status: "unanswered", reason: "nothing_to_answer" });
		expect(setup.faux.state.callCount).toBe(calls);
		expect((await harness.snapshot(LiveDoc, root.id, context))?.runFailure?.reason).toBe("nothing_to_answer");
		await harness.close(context);
	});

	// #11043
	it("continues an answer with tool calls cut off at its output limit, which ends in their missing results", async () => {
		const setup = chatSetup();
		const seen: Message["role"][][] = [];
		setup.faux.setResponses([
			fauxAssistantMessage([fauxText("calling"), fauxToolCall("echo", {}, { id: "c1" })], { stopReason: "length" }),
			answering("resumed", seen),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		// The run answered: a cut-off answer is an answer, and its calls never ran.
		expect((await (await root.submit({ type: "input", content: "go" }, context)).wait(context)).status).toBe("done");
		const settled = await (await root.submit({ type: "continue" }, context)).wait(context);
		expect(await answerText(root, settled)).toBe("resumed");
		expect(seen.at(-1)?.slice(-2)).toEqual(["assistant", "toolResult"]);
		await harness.close(context);
	});

	// #11043
	it("does not continue a text answer cut off at its output limit", async () => {
		const setup = chatSetup();
		setup.faux.setResponses([fauxAssistantMessage([fauxText("cut")], { stopReason: "length" })]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "write a lot" }, context)).wait(context);
		const settled = await (await root.submit({ type: "continue" }, context)).wait(context);
		expect(settled).toMatchObject({ status: "unanswered", reason: "nothing_to_answer" });
		expect(setup.faux.state.callCount).toBe(1);
		await harness.close(context);
	});

	// #11043
	it("answers a run interrupted by a host that died while the model answered", async () => {
		const path = await sqlitePath();
		const first = chatSetup({ tokensPerSecond: 20, tokenSize: { min: 1, max: 1 } });
		first.faux.setResponses([fauxAssistantMessage("z".repeat(400))]);
		first.settings.progress = { persistWithinMs: 0 };
		let opened = await open(path, first);
		const id = (await opened.root.submit({ type: "input", content: "hi" }, context)).id;
		await waitFor(
			async () =>
				(await opened.harness.snapshot(LiveDoc, opened.root.id, context))?.generation?.message !== undefined,
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		opened.kill();

		const setup = chatSetup();
		setup.settings.retry = { enabled: false };
		const seen: Message["role"][][] = [];
		setup.faux.setResponses([answering("after the crash", seen)]);
		opened = await open(path, setup);
		const interrupted = await (await opened.harness.submission(id, context))!.wait(context);
		expect(interrupted).toMatchObject({ status: "unanswered", reason: "interrupted" });
		const settled = await (await opened.root.submit({ type: "continue" }, context)).wait(context);
		expect(await answerText(opened.root, settled)).toBe("after the crash");
		// The aborted partial is not model context: the request ends in the user message.
		expect(seen.at(-1)?.at(-1)).toBe("user");
		await opened.harness.close(context);
	});

	// #11043
	it("places a reset a failed run kept, and finds nothing to answer in the context it starts", async () => {
		const setup = chatSetup();
		const gate = deferred();
		const reached = deferred();
		setup.faux.setResponses([
			async () => {
				reached.resolve();
				await gate.promise;
				return failure();
			},
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const first = await root.submit({ type: "input", content: "first" }, context);
		await reached.promise;
		await root.reset(undefined, context);
		gate.resolve();
		expect(await first.wait(context)).toMatchObject({ status: "unanswered", reason: "model_error" });
		expect((await harness.snapshot(InboxDoc, root.id, context))?.items).toHaveLength(1);

		const settled = await (await root.submit({ type: "continue" }, context)).wait(context);
		expect(settled).toMatchObject({ status: "unanswered", reason: "nothing_to_answer" });
		expect((await harness.snapshot(InboxDoc, root.id, context))?.items ?? []).toEqual([]);
		expect((await root.context(context)).messages.filter((message) => message.role !== "system")).toEqual([]);
		expect(setup.faux.state.callCount).toBe(1);
		await harness.close(context);
	});

	// #11043
	it("starts the inputs queued behind a continue with nothing to answer under afterFailedRun continue", async () => {
		const setup = chatSetup();
		setup.settings.afterFailedRun = "continue";
		setup.faux.setResponses([fauxAssistantMessage("answered"), fauxAssistantMessage("second answered")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "one" }, context)).wait(context);
		const resumed = await root.submit({ type: "continue" }, context);
		const queued = await root.submit({ type: "input", content: "two", whenBusy: "followUp" }, context);
		expect((await queued.status(context)).status).toBe("queued");
		expect(await resumed.wait(context)).toMatchObject({ status: "unanswered", reason: "nothing_to_answer" });
		const settled = await queued.wait(context);
		expect(await answerText(root, settled)).toBe("second answered");
		await harness.close(context);
	});

	// #11043
	it("is submitted by a tool through the handle of a conversation it owns, and rejected there while busy", async () => {
		const setup = chatSetup();
		const busy = deferred();
		const release = deferred();
		const outcome: { busy?: unknown; first?: string; resumed?: string } = {};
		addTool(
			setup.registry,
			defineTool({
				name: "delegate",
				description: "Delegates",
				parameters: Type.Object({}),
				execute: async (_args, api, callContext) => {
					const child = await api.commit(async (tx) => {
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						await configure(tx, created.id, { model: { provider: "faux", modelId: "faux-1" } });
						return created.id;
					}, callContext);
					const handle = (await api.conversation(child, callContext))!;
					const first = await (await handle.submit({ type: "input", content: "work" }, callContext)).wait(
						callContext,
					);
					outcome.first = first.status;
					const resumed = await handle.submit({ type: "continue" }, callContext);
					await busy.promise;
					outcome.busy = await handle.submit({ type: "continue" }, callContext).catch((error: unknown) => error);
					release.resolve();
					const settled = await resumed.wait(callContext);
					outcome.resumed = settled.status;
					return { output: [{ type: "text", text: settled.status }] };
				},
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("delegate", {}, { id: "c1" })], { stopReason: "toolUse" }),
			failure,
			async () => {
				busy.resolve();
				await release.promise;
				return fauxAssistantMessage("child recovered");
			},
			fauxAssistantMessage("done"),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(outcome).toMatchObject({ first: "unanswered", resumed: "done" });
		expect(outcome.busy).toBeInstanceOf(ConversationBusy);
		await harness.close(context);
	});

	// #11043
	it("starts a root trace linked to its caller, as an input does", async () => {
		const setup = chatSetup();
		const telemetry = new InMemoryTelemetryContext();
		setup.faux.setResponses([failure, fauxAssistantMessage("recovered")]);
		const harness = await Harness.open(
			new MemoryStorage(),
			{ models: setup.models, registry: setup.registry, settings: setup.settings, telemetry },
			context,
		);
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		const id = await telemetry.startSpan({ name: "caller" }, async (caller) => {
			const callContext = withTelemetry(caller, context);
			const resumed = await root.submit({ type: "continue" }, callContext);
			await resumed.wait(callContext);
			return resumed.id;
		});
		await harness.waitForIdle(context);
		await waitFor(() => telemetry.getSpans().every((span) => span.settled));
		const spans = telemetry.getSpans();
		const caller = spans.find((span) => span.name === "caller")!;
		const submit = spans.find(
			(span) => span.name === "pi.durable.submit" && span.attributes["submission.id"] === id,
		)!;
		expect(submit).toMatchObject({ parentId: null, attributes: { result: "placed" } });
		expect(submit.links).toEqual([{ context: caller.context, attributes: {} }]);
		expect((await (await harness.submission(id, context))!.status(context)).trace).toEqual(submit.context);
		expect(
			spans.some(
				(span) =>
					span.name === "pi.durable.phase" &&
					span.attributes.phase === "prepare" &&
					JSON.stringify(span.parentContext) === JSON.stringify(submit.context),
			),
		).toBe(true);
		await harness.close(context);
	});

	// #11043
	it("places inputs a failed run left queued first, and they join its run", async () => {
		const setup = chatSetup();
		const gate = deferred();
		const reached = deferred();
		setup.faux.setResponses([
			async () => {
				reached.resolve();
				await gate.promise;
				return failure();
			},
			fauxAssistantMessage("both handled"),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await root.submit({ type: "input", content: "first" }, context);
		await reached.promise;
		const queued = await root.submit({ type: "input", content: "second", whenBusy: "followUp" }, context);
		gate.resolve();
		await harness.waitForIdle(context);
		expect((await queued.status(context)).status).toBe("queued");

		const resumed = await root.submit({ type: "continue" }, context);
		const live = await harness.snapshot(LiveDoc, root.id, context);
		expect(live?.run?.inputs).toEqual([queued.id, resumed.id]);
		const [byQueued, byContinue] = [await queued.wait(context), await resumed.wait(context)];
		expect(await answerText(root, byContinue)).toBe("both handled");
		expect(byQueued).toMatchObject({ status: "done", answer: (byContinue as { answer: number }).answer });
		await harness.close(context);
	});
});
