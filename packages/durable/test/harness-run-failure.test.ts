// `pi.live.runFailure`: why the newest run ended without an answer, as state a renderer shows (#11327).
import { type FauxResponseStep, fauxAssistantMessage, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
	type AfterFailedRun,
	type Conversation,
	defineTool,
	type Harness,
	LiveDoc,
	type LiveState,
	MemoryStorage,
	type RunFailure,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { chatSetup, openChat, unanswered } from "./chat-support.ts";
import { addTool } from "./harness-support.ts";
import { context } from "./session-support.ts";
import { deferred } from "./task-support.ts";

async function live(harness: Harness, conversation: Conversation): Promise<Readonly<LiveState>> {
	return (await harness.snapshot(LiveDoc, conversation.id, context)) ?? {};
}

/** A response that fails for good once `gate` opens; `reached` resolves when it was requested. */
function failingOnce() {
	const gate = deferred();
	const reached = deferred();
	const step: FauxResponseStep = async () => {
		reached.resolve();
		await gate.promise;
		return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Invalid request" });
	};
	return { step, gate, reached };
}

describe("pi.live.runFailure", () => {
	it("records a model error with its text, and a later run clears it", async () => {
		const setup = chatSetup();
		setup.faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "Invalid request" }),
			fauxAssistantMessage([fauxText("fine")]),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		const settled = await submission.wait(context);
		expect(settled).toMatchObject({ status: "unanswered", reason: "model_error", detail: "Invalid request" });
		const failure = (await live(harness, root)).runFailure;
		expect(failure).toEqual({
			taskId: expect.any(Number),
			inputs: [submission.id],
			reason: "model_error",
			detail: "Invalid request",
			first: expect.any(Number),
		} satisfies RunFailure);
		const next = await root.submit({ type: "input", content: "again" }, context);
		// The commit that starts the next run removes it.
		expect((await live(harness, root)).runFailure).toBeUndefined();
		expect((await next.wait(context)).status).toBe("done");
		expect(await live(harness, root)).toEqual({});
		await harness.close(context);
	});

	it("records a missing model with which one", async () => {
		const setup = chatSetup();
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await root.configure({ model: { provider: "faux", modelId: "gone" } }, context);
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		const settled = await submission.wait(context);
		expect(settled).toMatchObject({ status: "unanswered", reason: "no_model" });
		// The settlement is unchanged: no detail.
		expect(settled).not.toHaveProperty("detail");
		expect((await live(harness, root)).runFailure).toMatchObject({
			inputs: [submission.id],
			reason: "no_model",
			detail: "Model faux/gone is not available",
		});
		await harness.close(context);
	});

	it("records an abort", async () => {
		const setup = chatSetup();
		const busy = unanswered();
		setup.faux.setResponses([busy.step]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		await busy.reached;
		const taskId = (await live(harness, root)).run!.taskId;
		await root.abort(context);
		expect(await submission.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		expect((await live(harness, root)).runFailure).toEqual({
			taskId,
			inputs: [submission.id],
			reason: "aborted",
			first: expect.any(Number),
		});
		await harness.close(context);
	});

	it("records a reset that cut the run before an answer, kept by the run its queued input starts", async () => {
		const setup = chatSetup();
		const gate = deferred();
		const started = deferred();
		addTool(
			setup.registry,
			defineTool({
				name: "hold",
				description: "Waits",
				parameters: Type.Object({}),
				execute: async () => {
					started.resolve();
					await gate.promise;
					return {};
				},
			}),
		);
		const second = unanswered();
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("hold", {}, { id: "c1" })], { stopReason: "toolUse" }),
			second.step,
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const first = await root.submit({ type: "input", content: "go" }, context);
		await started.promise;
		await root.reset(undefined, context);
		const followUp = await root.submit({ type: "input", content: "next", whenBusy: "followUp" }, context);
		gate.resolve();
		expect(await first.wait(context)).toMatchObject({ status: "unanswered", reason: "reset" });
		await second.reached;
		const state = await live(harness, root);
		// The follow-up's run started in the commit that ended the first; the failure stays until a later run starts.
		expect(state.run?.inputs).toEqual([followUp.id]);
		expect(state.runFailure).toMatchObject({ inputs: [first.id], reason: "reset" });
		await root.abort(context);
		expect((await live(harness, root)).runFailure).toMatchObject({ inputs: [followUp.id], reason: "aborted" });
		await harness.close(context);
	});

	it("keeps the failure while a run continues the queue in the same commit, and replaces it with the next", async () => {
		for (const policy of ["continue", "keep"] as const satisfies readonly AfterFailedRun[]) {
			const setup = chatSetup();
			setup.settings.afterFailedRun = policy;
			const failing = failingOnce();
			const busy = unanswered();
			setup.faux.setResponses([failing.step, busy.step, fauxAssistantMessage([fauxText("third")])]);
			const { harness, root } = await openChat(new MemoryStorage(), setup);
			const first = await root.submit({ type: "input", content: "first" }, context);
			await failing.reached.promise;
			const second = await root.submit({ type: "input", content: "second", whenBusy: "followUp" }, context);
			failing.gate.resolve();
			await first.wait(context);
			if (policy === "continue") {
				await busy.reached;
				const state = await live(harness, root);
				expect(state.run?.inputs).toEqual([second.id]);
				expect(state.runFailure).toMatchObject({ inputs: [first.id], reason: "model_error" });
			} else {
				await harness.waitForIdle(context);
				expect((await live(harness, root)).runFailure).toMatchObject({ inputs: [first.id] });
			}
			await harness.close(context);
		}
	});
});
