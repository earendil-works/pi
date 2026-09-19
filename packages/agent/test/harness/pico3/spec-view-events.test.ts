import assert from "node:assert/strict";
import type { Context } from "@earendil-works/chord";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { onTestFinished, test } from "vitest";
import type { ConversationHandle } from "../../../src/harness/pico3/harness.ts";
import type { ConversationView, Envelope, Models, ViewEvent } from "../../../src/harness/pico3/types.ts";
import { ctx, fake, Gate, model, open } from "./helpers.ts";

type SpecWatch = {
	readonly view: ConversationView;
	readonly revision: number;
	readonly closed: boolean;
	start(listener: (envelope: Envelope) => void): void;
	stop(): void;
};

const specWatch = (conversation: Pick<ConversationHandle<object>, "watch">) =>
	conversation.watch(ctx) as unknown as Promise<SpecWatch>;

const usage = (): AssistantMessage["usage"] => ({
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function partialModels(gate: Gate): Models {
	const resolved = {
		id: "fake-1",
		name: "Fake",
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		baseUrl: "",
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	};
	return {
		resolve: () => resolved,
		async *stream(_model, _request, context: Context): AsyncIterable<AssistantMessageEvent> {
			const partial: AssistantMessage = {
				role: "assistant",
				content: [],
				api: resolved.api,
				provider: resolved.provider,
				model: resolved.id,
				usage: usage(),
				stopReason: "stop",
				timestamp: 1,
			};
			yield { type: "start", partial };
			partial.content.push({ type: "text", text: "" });
			yield { type: "text_start", contentIndex: 0, partial };
			(partial.content[0] as { text: string }).text = "partial";
			yield { type: "text_delta", contentIndex: 0, delta: "partial", partial };
			await gate.wait(context);
			yield { type: "text_end", contentIndex: 0, content: "partial", partial };
			yield { type: "done", reason: "stop", message: { ...partial, stopReason: "stop" } };
		},
		async fetchDeferred() {
			throw new Error("not deferred");
		},
		async cancelDeferred() {},
	};
}

test("watch snapshot is the single flat rendering document and excludes raw documents, records, checkpoints, and private slot state", async () => {
	const env = await open({});
	onTestFinished(() => env.close());
	const watch = await specWatch(env.root);
	assert.deepEqual(
		Object.keys(watch.view).sort(),
		["compaction", "config", "conversation", "entries", "inbox", "plugins", "tasks", "turn"]
			.filter((key) => key in watch.view)
			.sort(),
	);
	assert.ok("config" in watch.view);
	assert.ok("inbox" in watch.view);
	assert.ok("plugins" in watch.view);
	assert.ok(!("rewindable" in (watch.view as object)));
	assert.ok(!("sticky" in (watch.view as object)));
	for (const task of Object.values(watch.view.tasks)) {
		assert.ok(!("checkpoint" in task));
		assert.ok(!("outcome" in task));
		assert.ok(!("memos" in task));
	}
	watch.stop();
});

test("watch revisions are contiguous per watch even when unrelated conversation commits create global storage gaps", async () => {
	const env = await open({});
	onTestFinished(() => env.close());
	const other = await env.h.createConversation({}, ctx);
	const watch = await specWatch(env.root);
	const revisions: number[] = [];
	watch.start((envelope) => revisions.push(envelope.revision));
	await env.root.write({ kind: "root.one" }, ctx);
	await other.write({ kind: "other.only" }, ctx);
	await env.root.write({ kind: "root.two" }, ctx);
	assert.deepEqual(revisions, [watch.revision + 1, watch.revision + 2]);
	watch.stop();
});

test("one admission commit produces one atomic op envelope with entry/input/turn events", async () => {
	const gate = new Gate();
	const env = await open({ models: fake({ respond: () => ({ text: "answer" }), gate }) });
	onTestFinished(() => env.close());
	const watch = await specWatch(env.root);
	const envelopes: Envelope[] = [];
	watch.start((envelope) => envelopes.push(envelope));
	const input = await env.root.send({ content: "hello" }, ctx);
	await gate.arrivals(1);
	const admissions = envelopes.filter((envelope) => envelope.events.some((event) => event.type === "turn.started"));
	assert.equal(admissions.length, 1, "send has exactly one atomic admission envelope");
	const admission = admissions[0]!;
	assert.ok(admission.ops.some((op) => op[0] === "p" && op[1]?.[0] === "entries"));
	assert.ok(admission.ops.some((op) => op[0] === "s" && op[1]?.[0] === "turn"));
	assert.deepEqual(
		admission.events.map((event) => event.type),
		["input.placed", "entry.added", "turn.started"],
	);
	gate.open();
	await input.wait(ctx);
	watch.stop();
});

test("terminal answer entry, input settlement, generation completion, and turn end share one envelope", async () => {
	const gate = new Gate();
	const env = await open({ models: fake({ respond: () => ({ text: "answer" }), gate }) });
	onTestFinished(() => env.close());
	const watch = await specWatch(env.root);
	const envelopes: Envelope[] = [];
	watch.start((envelope) => envelopes.push(envelope));
	const input = await env.root.send({ content: "hello" }, ctx);
	await gate.arrivals(1);
	gate.open();
	const result = await input.wait(ctx);
	const terminal = envelopes.find((envelope) => envelope.events.some((event) => event.type === "turn.ended"));
	assert.ok(terminal);
	assert.ok(terminal.events.some((event) => event.type === "generation.completed"));
	assert.ok(
		terminal.events.some(
			(event) => event.type === "turn.ended" && event.status === "done" && event.answer === result.answer,
		),
	);
	assert.ok(terminal.events.some((event) => event.type === "entry.added" && event.entry.id === result.answer));
	assert.ok(terminal.ops.some((op) => op[0] === "d" && op[1]?.[0] === "turn"));
	watch.stop();
});

test("late joiner reconstructs streaming generation state without replayed events", async () => {
	const gate = new Gate();
	const env = await open({ models: partialModels(gate), root: { rewindable: { model } } });
	onTestFinished(() => env.close());
	const input = await env.root.send({ content: "stream" }, ctx);
	await gate.arrivals(1);
	const watch = await specWatch(env.root);
	assert.equal(watch.view.turn?.generation?.stage, "streaming");
	assert.equal((watch.view.turn?.message?.content[0] as { text?: string } | undefined)?.text, "partial");
	const seen: Envelope[] = [];
	watch.start((envelope) => seen.push(envelope));
	assert.deepEqual(seen, [], "capture does not replay historical events");
	gate.open();
	await input.wait(ctx);
	assert.ok(seen.length > 0);
	watch.stop();
});

test("a head commit is represented by transcript splice ops and matching entry/head events", async () => {
	const env = await open({});
	onTestFinished(() => env.close());
	await env.root.write({ kind: "before" }, ctx);
	const watch = await specWatch(env.root);
	let envelope: Envelope | undefined;
	watch.start((next) => {
		envelope = next;
	});
	await env.root.reset("fresh", ctx);
	assert.ok(envelope);
	const entryOps = envelope.ops.filter((op) => op[0] === "p" && op[1]?.[0] === "entries");
	assert.equal(entryOps.length, 2);
	assert.equal(entryOps[0]?.[2], 0);
	assert.ok((entryOps[0]?.[3] as number) > 0);
	assert.deepEqual(
		envelope.events.map((event) => event.type),
		["head.moved", "entry.added"],
	);
	watch.stop();
});

test("a namespace projection failure closes its watches without failing the persisted writer", async () => {
	const reports: unknown[] = [];
	const env = await open({ onReport: (error) => reports.push(error) });
	onTestFinished(() => env.close());
	const namespace = env.h.namespace<{ fail: boolean }>(
		"spec.bad-projection",
		{ sticky: { fail: false } },
		{
			view: (slice) => {
				if (slice.fail) throw new Error("projection failed");
				return { ok: true };
			},
		},
	);
	const watch = await env.root.watch(ctx);
	watch.start(() => {});
	await env.root.commit((tx) => {
		tx.plugins(namespace).fail = true;
	}, ctx);
	assert.equal(watch.closed, true);
	assert.match(String(reports[0]), /projection failed/);
	assert.equal((await env.root.sticky(ctx)).plugins[namespace.id]?.fail, true);
});

test("all watchers of one conversation receive the same commit envelope object while retaining independent lifecycle", async () => {
	const env = await open({});
	onTestFinished(() => env.close());
	const first = await specWatch(env.root);
	const second = await specWatch(env.root);
	let a: Envelope | undefined;
	let b: Envelope | undefined;
	first.start((envelope) => {
		a = envelope;
	});
	second.start((envelope) => {
		b = envelope;
	});
	await env.root.write({ kind: "shared" }, ctx);
	assert.ok(a && b);
	assert.equal(a, b, "fan-out reuses the one envelope assembled for the conversation commit");
	first.stop();
	await env.root.write({ kind: "second-only" }, ctx);
	assert.equal(first.closed, true);
	assert.equal(second.closed, false);
	second.stop();
});

test("pre-start delivery is ordered, start is idempotent, and stop has a hard no-callback boundary", async () => {
	const env = await open({});
	onTestFinished(() => env.close());
	const watch = await specWatch(env.root);
	await env.root.write({ kind: "buffered.one" }, ctx);
	await env.root.write({ kind: "buffered.two" }, ctx);
	const received: Envelope[] = [];
	watch.start((envelope) => received.push(envelope));
	watch.start(() => {
		throw new Error("second start must be ignored");
	});
	assert.equal(received.length, 2);
	assert.equal(received[1]!.revision, received[0]!.revision + 1);
	const countAtStop = received.length;
	watch.stop();
	watch.stop();
	await env.root.write({ kind: "after.stop" }, ctx);
	assert.equal(received.length, countAtStop);
});

test("listener failure is isolated from persistence and from sibling watches", async () => {
	const reports: unknown[] = [];
	const env = await open({ onReport: (error) => reports.push(error) });
	onTestFinished(() => env.close());
	const broken = await specWatch(env.root);
	const healthy = await specWatch(env.root);
	const healthyEvents: ViewEvent[][] = [];
	broken.start(() => {
		throw new Error("listener failed");
	});
	healthy.start((envelope) => healthyEvents.push(envelope.events));
	const persisted = await env.root.write({ kind: "survives.listener" }, ctx);
	assert.ok(persisted > 0);
	assert.equal(broken.closed, true);
	assert.equal(healthy.closed, false);
	assert.equal(healthyEvents.length, 1);
	assert.match(String(reports[0]), /listener failed/);
	healthy.stop();
});
