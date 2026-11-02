import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { type DurableObjectState, type DurableObjectStub, env } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, type TaskId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { nativeTimer } from "../src/timers.ts";
import type { TestSession } from "./worker.ts";

const context = BACKGROUND_CONTEXT;
const fresh = () => env.SESSIONS.get(env.SESSIONS.newUniqueId());

/** Poll `check` inside the object until it holds. */
async function eventually(
	stub: DurableObjectStub,
	check: (instance: TestSession, state: DurableObjectState) => Promise<boolean>,
): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (await runInDurableObject(stub, check)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Condition not reached");
}

describe("a Harness woken by its Durable Object alarm", () => {
	it("sleeps through an eviction and resumes the task from its alarm", async () => {
		const stub = fresh();
		const sleep = 600_000;
		const { id, at } = await runInDurableObject(stub, async (instance: TestSession) => {
			const at = instance.now() + sleep;
			return { id: await instance.remind(at), at };
		});
		await eventually(stub, async (instance, state) => {
			const record = await instance.harness.getTask(id, context);
			return record?.state.status === "sleeping" && (await state.storage.getAlarm()) === at;
		});
		await runInDurableObject(stub, async (instance: TestSession) => {
			expect(instance.harness.wake()).toEqual({ active: false, at });
			expect(instance.wakes.at(-1)).toEqual({ active: false, at });
		});

		await evictDurableObject(stub);
		// A new instance: the sleep is read from storage, and the alarm stays.
		await runInDurableObject(stub, async (instance: TestSession, state) => {
			expect(instance.harness.wake()).toEqual({ active: false, at });
			expect(await state.storage.getAlarm()).toBe(at);
			// Time passes while the object sleeps.
			instance.advance(sleep);
		});
		await evictDurableObject(stub);
		expect(await runDurableObjectAlarm(stub)).toBe(true);

		const woke = await runInDurableObject(stub, async (instance: TestSession) => {
			const settled = await instance.harness.waitForTask(id as TaskId<number>, context);
			return settled.state.outcome;
		});
		expect(woke).toMatchObject({ status: "completed" });
		expect(woke.status === "completed" && woke.result).toBeGreaterThanOrEqual(at);
		// Nothing is left to do: the alarm is gone.
		await eventually(stub, async (_instance, state) => (await state.storage.getAlarm()) === null);
	});

	it("recovers a turn an eviction cut off mid-stream through the alarms, retrying the charged attempt", async () => {
		const stub = fresh();
		await runInDurableObject(stub, async (instance: TestSession, state) => {
			instance.script(["hang", "recovered"]);
			await instance.submit("hi", "turn-1");
			await instance.hanging.promise;
			expect(instance.harness.wake().active).toBe(true);
			// The heartbeat alarm armed before the input was admitted.
			expect(await state.storage.getAlarm()).not.toBeNull();
		});

		await evictDurableObject(stub);
		expect(await runDurableObjectAlarm(stub)).toBe(true);

		const answer = await runInDurableObject(stub, async (instance: TestSession) => {
			const root = await instance.root();
			// The same request ID finds the submission admitted before the eviction.
			const submission = await root.submit({ type: "input", content: "hi", requestId: "turn-1" }, context);
			const settled = await submission.wait(context);
			if (settled.status !== "done" || settled.type !== "input") throw new Error(`Unexpected ${settled.status}`);
			const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
			const message = entry?.model?.[0];
			return message?.role === "assistant" ? message.content : undefined;
		});
		expect(answer).toEqual([{ type: "text", text: "recovered" }]);
		await eventually(stub, async (_instance, state) => (await state.storage.getAlarm()) === null);
	});

	it("can evict an object whose Harness keeps idle documents and contexts in memory", async () => {
		const stub = fresh();
		await runInDurableObject(stub, async (instance: TestSession) => {
			instance.script(["answer"]);
			await instance.submit("hi", "turn-1");
			const root = await instance.root();
			await (await root.submit({ type: "input", content: "hi", requestId: "turn-1" }, context)).wait(context);
		});
		// Retention timers would keep the object running; the default declines them in Workers.
		expect(nativeTimer(() => {}, 10, { background: true })).toBeUndefined();
		const evicted = await Promise.race([
			evictDurableObject(stub).then(() => "evicted"),
			new Promise((resolve) => setTimeout(() => resolve("still running"), 2_000)),
		]);
		expect(evicted).toBe("evicted");
	});
});
