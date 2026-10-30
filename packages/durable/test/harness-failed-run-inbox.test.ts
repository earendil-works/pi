import { type FauxResponseStep, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type AfterFailedRun, AssistantEntry, MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { chatSetup, openChat, textOf } from "./chat-support.ts";
import { context } from "./session-support.ts";
import { deferred } from "./task-support.ts";

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

/** A run that fails with an input queued behind it, under `policy`; returns how the queued input settled. */
async function failWithQueuedInput(policy: AfterFailedRun | undefined) {
	const setup = chatSetup();
	if (policy !== undefined) setup.settings.afterFailedRun = policy;
	const failing = failingOnce();
	setup.faux.setResponses([failing.step, fauxAssistantMessage("second answer"), fauxAssistantMessage("third answer")]);
	const { harness, root } = await openChat(new MemoryStorage(), setup);
	const first = await root.submit({ type: "input", content: "Analyze this report" }, context);
	await failing.reached.promise;
	const second = await root.submit({ type: "input", content: "Email me the summary", whenBusy: "followUp" }, context);
	failing.gate.resolve();
	expect(await first.wait(context)).toMatchObject({ status: "unanswered", reason: "model_error" });
	return { harness, root, second };
}

describe("inputs queued behind a failed run", () => {
	it("stay queued by default", async () => {
		const { harness, root, second } = await failWithQueuedInput(undefined);
		await harness.waitForIdle(context);
		expect(await second.status(context)).toMatchObject({ status: "queued" });
		// The next input runs the queue, as before.
		const third = await root.submit({ type: "input", content: "Anything else?" }, context);
		expect((await second.wait(context)).status).toBe("done");
		expect((await third.wait(context)).status).toBe("done");
		await harness.close(context);
	});

	it("start the next run with continue", async () => {
		const { harness, root, second } = await failWithQueuedInput("continue");
		const settled = await second.wait(context);
		if (settled.status !== "done" || settled.type !== "input") throw new Error(`Unexpected ${settled.status}`);
		const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		expect(textOf(answer?.model?.[0])).toBe("second answer");
		await harness.close(context);
	});

	it("place queued writes, and keep them with withdraw", async () => {
		for (const policy of ["continue", "withdraw"] as const) {
			const setup = chatSetup();
			setup.settings.afterFailedRun = policy;
			const failing = failingOnce();
			setup.faux.setResponses([failing.step, fauxAssistantMessage("second answer")]);
			const { harness, root } = await openChat(new MemoryStorage(), setup);
			const first = await root.submit({ type: "input", content: "first" }, context);
			await failing.reached.promise;
			const note = { role: "user", content: "a note the model sees", timestamp: 1 } as const;
			const write = await root.submit({ type: "write", entry: { kind: "test.note", model: [note] } }, context);
			expect(await write.status(context)).toMatchObject({ status: "queued" });
			failing.gate.resolve();
			await first.wait(context);
			await harness.waitForIdle(context);
			// `continue` places the write at the failed run's boundary; `withdraw` withdraws inputs only.
			expect(await write.status(context)).toMatchObject({ status: policy === "continue" ? "done" : "queued" });
			await harness.close(context);
		}
	});

	it("settle unanswered with run_failed with withdraw", async () => {
		const { harness, second } = await failWithQueuedInput("withdraw");
		expect(await second.wait(context)).toMatchObject({ status: "unanswered", reason: "run_failed" });
		await harness.close(context);
	});
});
