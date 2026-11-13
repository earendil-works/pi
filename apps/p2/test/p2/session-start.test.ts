// A new session's first messages (plugins/chat/session-start.ts): shown before the session exists, the session created
// once a creator is connected, the messages handed to its main conversation's outbox, and put back into the composer
// when the server refuses the creation.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Outgoing, outboxOf } from "../../plugins/chat/outbox.ts";
import { type Creator, SessionStart } from "../../plugins/chat/session-start.ts";

const message = (id: string): Outgoing => ({
	id,
	text: `text ${id}`,
	files: [],
	whenBusy: "followUp",
	item: { type: "user", key: `outgoing-${id}`, text: `text ${id}`, images: [], files: [] },
});
/** Where a start begins, with a new session ID (the page chooses it at the first Send). */
const place = () =>
	({
		session: crypto.randomUUID(),
		location: { env: null, cwd: "/tmp" },
		choice: { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" },
	}) as const;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const ticks = async (count: number) => {
	for (let index = 0; index < count; index++) await tick();
};

/** A creator recording what it did; `fail` decides per call what goes wrong, `gate` holds a creation until released. */
function creator(fail: (call: number) => "refuse" | "drop" | undefined = () => undefined) {
	const created: string[] = [];
	/** The session ID each creation asked for. */
	const asked: string[] = [];
	const restored: { ids: string[]; error: string }[] = [];
	let calls = 0;
	let gate: Promise<void> | undefined;
	const value: Creator = {
		create: async ({ session }) => {
			const call = ++calls;
			asked.push(session);
			await gate;
			const outcome = fail(call);
			if (outcome === "refuse") throw new Error("refused");
			if (outcome === "drop") throw new Error("connection lost");
		},
		refused: (error) => error instanceof Error && error.message === "refused",
		created: (session) => created.push(session),
		restore: (messages, error) =>
			restored.push({ ids: messages.map((entry) => entry.id), error: (error as Error).message }),
	};
	return {
		value,
		created,
		asked,
		restored,
		calls: () => calls,
		hold: () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			gate = promise;
			return () => {
				gate = undefined;
				resolve();
			};
		},
	};
}

describe("session start", () => {
	it("shows messages before a creator connects, then creates the session once and hands them to its outbox", async () => {
		const start = new SessionStart({ retryDelay: () => 1 });
		start.add(message("a"), place());
		await tick();
		assert.deepEqual(
			start.snapshot()?.messages.map((entry) => entry.id),
			["a"],
		);
		const { value, created, calls } = creator();
		start.connect(value);
		await ticks(5);
		assert.equal(calls(), 1);
		assert.equal(created.length, 1);
		assert.equal(start.snapshot(), undefined);
		assert.deepEqual(
			outboxOf(`${created[0]}#1`)
				.snapshot()
				.map((entry) => entry.id),
			["a"],
		);
	});

	it("keeps the first message's place; messages sent while creating join the same session", async () => {
		const start = new SessionStart({ retryDelay: () => 1 });
		const { value, created, calls, hold } = creator();
		const release = hold();
		start.connect(value);
		start.add(message("a"), place());
		start.add(message("b"), { ...place(), location: { env: null, cwd: "/elsewhere" } });
		await ticks(3);
		assert.equal(start.snapshot()?.location.cwd, "/tmp");
		release();
		await ticks(5);
		assert.equal(calls(), 1);
		assert.deepEqual(
			outboxOf(`${created[0]}#1`)
				.snapshot()
				.map((entry) => entry.id),
			["a", "b"],
		);
	});

	it("puts the messages back when the server refuses the creation", async () => {
		const start = new SessionStart({ retryDelay: () => 1 });
		const { value, created, restored } = creator(() => "refuse");
		start.add(message("a"), place());
		start.add(message("b"), place());
		start.connect(value);
		await ticks(5);
		assert.deepEqual(created, []);
		assert.deepEqual(restored, [{ ids: ["a", "b"], error: "refused" }]);
		assert.equal(start.snapshot(), undefined);
	});

	it("tries a lost connection again, and gives up after six failures while connected", async () => {
		const start = new SessionStart({ retryDelay: () => 1 });
		const flaky = creator((call) => (call === 1 ? "drop" : undefined));
		start.add(message("a"), place());
		start.connect(flaky.value);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(flaky.calls(), 2);
		assert.equal(flaky.created.length, 1);
		// The retry after a lost answer asks for the same session (a retried create answers the same row).
		assert.equal(flaky.asked[0], flaky.asked[1]);
		assert.equal(flaky.created[0], flaky.asked[0]);

		const broken = creator(() => "drop");
		start.connect(broken.value);
		start.add(message("b"), place());
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(broken.calls(), 6);
		assert.deepEqual(broken.restored, [{ ids: ["b"], error: "connection lost" }]);
	});

	it("waits while disconnected", async () => {
		const start = new SessionStart({ retryDelay: () => 1 });
		const { value, calls } = creator();
		start.connect(value);
		start.connect(undefined);
		start.add(message("a"), place());
		await ticks(5);
		assert.equal(calls(), 0);
		assert.deepEqual(
			start.snapshot()?.messages.map((entry) => entry.id),
			["a"],
		);
	});
});
