import assert from "node:assert/strict";
import { withAbortSignal } from "@earendil-works/chord/context";
import { onTestFinished, test } from "vitest";
import { kinds } from "../../../src/harness/pico3/harness.ts";
import { defineTask } from "../../../src/harness/pico3/types.ts";
import { ctx, echoScript, fake, Gate, open } from "./helpers.ts";

test("waitForTask/waitForInput/waitForIdle: registration is atomic with the state read; completion racing the registration never strands a waiter", async () => {
	const env = await open({});
	onTestFinished(() => env.close());
	const quick = defineTask<null, { phase: "x" }, null, null, null>({
		name: "quick",
		async initial() {
			return { next: { phase: "x" } };
		},
		phases: {
			async x() {
				return { done: () => ({ status: "completed", result: null }) };
			},
		},
		async abort() {
			return () => null;
		},
	});
	const env2 = await open({ taskKinds: [quick] });
	onTestFinished(() => env2.close());
	// 200 iterations: create and immediately wait; the task may terminalize before, during, or after the waiter enters the line.
	for (let i = 0; i < 200; i++) {
		const ref = await env2.root.commit(
			(tx) => tx.createTask(quick, null, { conversationId: 1, background: true }),
			ctx,
		);
		const t = await env2.h.waitForTask(ref.id, ctx);
		assert.equal(t.status, "terminal");
	}
	for (let i = 0; i < 50; i++) {
		const h = await env.root.send({ content: `m${i}` }, ctx);
		const [r] = await Promise.all([h.wait(ctx), env.root.waitForIdle(ctx), env.h.waitForIdle(ctx)]);
		assert.equal(r.status, "done");
	}
	// an already-terminal task returns immediately
	const first = (await env2.tasks())[0]!;
	assert.equal((await env2.h.waitForTask(first.id, ctx)).status, "terminal");
});

test("waiters: an aborted context rejects the waiter only; the durable work continues; an already-aborted context rejects immediately", async () => {
	const gate = new Gate();
	const env = await open({ models: fake({ respond: echoScript, gate }) });
	onTestFinished(() => env.close());
	const h = await env.root.send({ content: "A" }, ctx);
	const ac = new AbortController();
	const cctx = withAbortSignal(ac.signal, ctx);
	const p = h.wait(cctx);
	const q = env.root.waitForIdle(cctx);
	const gen = (await env.tasks()).find((t) => t.kind === "pi.generation")!;
	const r = env.h.waitForTask(gen.id, cctx);
	await gate.arrivals(1);
	ac.abort(new Error("gone"));
	await assert.rejects(p, /gone/);
	await assert.rejects(q, /gone/);
	await assert.rejects(r, /gone/);
	const dead = new AbortController();
	dead.abort(new Error("pre"));
	await assert.rejects(h.wait(withAbortSignal(dead.signal, ctx)), /pre/);
	gate.open();
	assert.equal((await h.wait(ctx)).status, "done"); // the turn finished regardless
});

test("Harness.waitForIdle does not resolve while a drain is about to dispatch a just-created task", async () => {
	const gate = new Gate();
	const env = await open({ models: fake({ respond: echoScript, gate }) });
	onTestFinished(() => env.close());
	const h = await env.root.send({ content: "A" }, ctx);
	let idleResolved = false;
	const idle = env.h.waitForIdle(ctx).then(() => {
		idleResolved = true;
	});
	await gate.arrivals(1);
	assert.equal(idleResolved, false);
	gate.open();
	await h.wait(ctx);
	await idle;
	assert.equal((await env.tasks()).filter((t) => t.status !== "terminal").length, 0);
	void kinds;
});
