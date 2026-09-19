import assert from "node:assert/strict";
import { onTestFinished, test } from "vitest";
import {
	applyEnvelope,
	type ConversationView,
	type Envelope,
	WATCH_CAPACITY,
} from "../../../src/harness/pico3/harness.ts";
import { ctx, echoScript, fake, Gate, open } from "./helpers.ts";

const shape = (v: ConversationView) =>
	v.entries.map((e) => `${e.id}:${e.kind.replace("pi.", "")}${e.head !== undefined ? `>${e.head}` : ""}`).join(" ");

test("watch: envelopes have contiguous revisions; one per visible commit; folded view equals a fresh capture", async () => {
	const env = await open({});
	onTestFinished(() => env.close());
	const w = await env.root.watch(ctx);
	const revisions: number[] = [];
	let folded = w.view;
	w.start((envelope) => {
		revisions.push(envelope.revision);
		folded = applyEnvelope(folded, envelope);
	});
	for (const t of ["one", "two"]) await (await env.root.send({ content: t }, ctx)).wait(ctx);
	await env.root.write({ kind: "note" }, ctx);
	for (let index = 1; index < revisions.length; index++) assert.equal(revisions[index], revisions[index - 1]! + 1);
	const fresh = await env.root.watch(ctx);
	assert.equal(shape(folded), shape(fresh.view));
	assert.deepEqual(folded, fresh.view);
	fresh.stop();
	w.stop();
	w.stop(); // idempotent
	const delivered = revisions.length;
	await env.root.write({ kind: "note" }, ctx);
	assert.equal(revisions.length, delivered); // no callbacks after stop
});

test("failed document commits do not break queued-input abort or later task-only watch updates", async () => {
	const gate = new Gate();
	const env = await open({ models: fake({ respond: echoScript, gate }) });
	onTestFinished(() => env.close());
	const active = await env.root.send({ content: "active" }, ctx);
	await gate.arrivals(1);
	const queued = await env.root.send({ content: "queued" }, ctx);
	const generation = (await env.tasks()).find((task) => task.kind === "pi.generation" && task.status !== "terminal")!;
	const watch = await env.root.watch(ctx);
	watch.start(() => {});
	await assert.rejects(
		env.root.commit((tx) => {
			tx.config(env.root.id).set("profile", "rolled-back");
			throw new Error("rollback");
		}, ctx),
		/rollback/,
	);
	assert.equal(await queued.abort(ctx), "aborted");
	assert.equal((await queued.result(ctx))?.reason, "aborted");
	assert.equal(await env.h.markTask(generation.id, ctx), "marked");
	assert.equal(watch.closed, false);
	await env.h.abortTask(generation.id, ctx);
	await active.wait(ctx);
	watch.stop();
});

test("watch: a listener throw closes only that watch, is reported, and never fails the writer; a second watch keeps going", async () => {
	const reports: unknown[] = [];
	const env = await open({ onReport: (e) => reports.push(e) });
	onTestFinished(() => env.close());
	const bad = await env.root.watch(ctx);
	const good = await env.root.watch(ctx);
	let goodCount = 0;
	bad.start(() => {
		throw new Error("bad listener");
	});
	good.start(() => {
		goodCount++;
	});
	const id = await env.root.write({ kind: "note" }, ctx); // resolves normally
	assert.ok(id > 0);
	assert.equal(bad.closed, true);
	assert.equal(good.closed, false);
	assert.equal(goodCount, 1);
	assert.match(String(reports[0]), /bad listener/);
});

test("watch: bounded capacity before start(); overflow closes the watch and reports; the client opens a fresh watch", async () => {
	const reports: unknown[] = [];
	const env = await open({ onReport: (e) => reports.push(e) });
	onTestFinished(() => env.close());
	const w = await env.root.watch(ctx);
	for (let i = 0; i <= WATCH_CAPACITY; i++) await env.root.write({ kind: "note" }, ctx);
	assert.equal(w.closed, true);
	assert.match(String(reports[0]), /capacity 256 exceeded/);
	const fresh = await env.root.watch(ctx);
	assert.equal(fresh.view.entries.filter((e) => e.kind === "note").length, WATCH_CAPACITY + 1);
	fresh.stop();
});

test("watch capture: fork-inherited head target, older head inside the range, and capture equals incremental fold", async () => {
	const gate = new Gate();
	const env = await open({ models: fake({ respond: echoScript, gate }) });
	onTestFinished(() => env.close());
	gate.open();
	await (await env.root.send({ content: "one" }, ctx)).wait(ctx);
	await (await env.root.send({ content: "two" }, ctx)).wait(ctx);
	await env.root.reset("carry on", ctx); // head H1 in the parent
	await (await env.root.send({ content: "three" }, ctx)).wait(ctx);
	const parentEntries = await env.entries();
	const h1 = parentEntries.find((e) => e.kind === "pi.handoff")!;
	const tip = parentEntries[parentEntries.length - 1]!;
	// child forks at the parent's tip; its own newest head points INTO the parent (at H1's position, i.e. an inherited entry)
	const child = await env.root.fork(tip.id, {}, ctx);
	const cw = await child.watch(ctx);
	let folded = cw.view;
	cw.start((envelope) => {
		folded = applyEnvelope(folded, envelope);
	});
	// add a passive entry, a generated exchange, then a head that points at the inherited handoff
	await child.write({ kind: "note" }, ctx);
	await (await child.send({ content: "four" }, ctx)).wait(ctx);
	await child.reset(undefined, ctx); // head H2 = self, later than H1
	const fresh = await child.watch(ctx);
	assert.equal(shape(fresh.view), shape(folded), "incremental fold equals a fresh capture");
	// the range starts at H2.head == H2 itself: exactly the reset entry
	const heads = fresh.view.entries.filter((e) => e.head !== undefined);
	assert.equal(heads.length, 1);
	fresh.stop();
	cw.stop();
	// Inherited case: a second child forked at the parent's tip whose newest head is the parent's H1 (inherited) — capture includes the inherited target and everything after it.
	const child2 = await env.root.fork(tip.id, {}, ctx);
	const cw2 = await child2.watch(ctx);
	const ids = cw2.view.entries.map((e) => e.id);
	assert.ok(ids.includes(h1.id), "inherited head entry retained at its position");
	assert.deepEqual(
		ids,
		parentEntries.filter((e) => e.id >= h1.id).map((e) => e.id),
	);
	// an older head INSIDE the range: the view keeps it (context derivation would not)
	let folded2 = cw2.view;
	cw2.start((envelope) => {
		folded2 = applyEnvelope(folded2, envelope);
	});
	await child2.reset("again", ctx); // H2 in child2; range = [H2]
	await (await child2.send({ content: "five" }, ctx)).wait(ctx);
	const fresh2 = await child2.watch(ctx);
	assert.equal(shape(fresh2.view), shape(folded2));
	fresh2.stop();
	cw2.stop();
});

test("applyEnvelope folds head truncation ops while preserving display-only and older in-range head entries", () => {
	const base: ConversationView = {
		conversation: { id: 1 },
		entries: [
			{ id: 1, conversationId: 1, kind: "pi.user" },
			{ id: 2, conversationId: 1, kind: "pi.summary", head: 2 },
			{ id: 3, conversationId: 1, kind: "pi.assistant" },
		],
		config: {},
		inbox: [],
		tasks: {},
		plugins: {},
	};
	const display = { id: 4, conversationId: 1, kind: "pi.assistant", data: { reason: "aborted" } };
	const handoff = { id: 5, conversationId: 1, kind: "pi.handoff", head: 3 };
	const first: Envelope = {
		revision: 9,
		ops: [
			["p", ["entries"], 0, 2, []],
			["p", ["entries"], 1, 0, [display, handoff]],
		],
		events: [],
	};
	const view = applyEnvelope(base, first);
	assert.deepEqual(
		view.entries.map((entry) => entry.id),
		[3, 4, 5],
	);
	const summary = { id: 6, conversationId: 1, kind: "pi.summary", head: 4 };
	const second: Envelope = {
		revision: 10,
		ops: [
			["p", ["entries"], 0, 1, []],
			["p", ["entries"], 2, 0, [summary]],
		],
		events: [],
	};
	const next = applyEnvelope(view, second);
	assert.deepEqual(
		next.entries.map((entry) => entry.id),
		[4, 5, 6],
	);
});
