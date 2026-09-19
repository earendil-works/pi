import assert from "node:assert/strict";
import { Type } from "typebox";
import { onTestFinished, test } from "vitest";
import { kinds } from "../../../src/harness/pico3/harness.ts";
import { defineTask, type Runtime, TaskContractFault } from "../../../src/harness/pico3/types.ts";
import { ctx, echoScript, fake, fakeHost, Gate, model, open, resultOf } from "./helpers.ts";

// ---------------------------------------------------------------------------
// §3 prospective busy()
// ---------------------------------------------------------------------------

test("overflow with nothing collapsible: the notice is appended by the terminal closure (the closing generation counts as gone); no inbox item is stranded", async () => {
	const models = fake({ respond: echoScript });
	const modelObj = models.resolve({ provider: "", modelId: "" })! as { contextWindow: number; maxTokens: number };
	const env = await open({ models, root: { rewindable: { model, keepRecent: 1000 } } });
	onTestFinished(() => env.close());
	modelObj.contextWindow = 50;
	modelObj.maxTokens = 10;
	const a = await env.root.send({ content: "x".repeat(2000) }, ctx);
	const r = await a.wait(ctx);
	assert.equal(r.reason, "failed");
	assert.equal(r.detail, "overflow");
	const es = await env.entries();
	assert.ok(
		es.some((e) => e.kind === "pi.notice"),
		"notice appended",
	);
	assert.deepEqual((await env.root.sticky(ctx)).inbox, []);
	assert.deepEqual((await env.root.sticky(ctx)).turn, { tools: [] });
});

test("a job's terminal-closure notification on an idle conversation appends immediately (a background job is not busy)", async () => {
	const host = fakeHost();
	const env = await open({ processHost: host });
	onTestFinished(() => env.close());
	const ref = await env.root.commit(
		(tx) =>
			tx.createTask(
				kinds.job,
				{ command: "x", args: [], cwd: "/", notify: true, rerun: false },
				{ conversationId: 1, background: true },
			),
		ctx,
	);
	await new Promise((r) => setTimeout(r, 30));
	host.exit(`${ref.id}:1`, 0);
	const t = await env.h.waitForTask(ref.id, ctx);
	assert.equal(t.outcome?.status, "completed");
	assert.ok((await env.entries()).some((e) => e.kind === "pi.notice"));
	assert.deepEqual((await env.root.sticky(ctx)).inbox, []);
});

test("a same-batch successor generation keeps the conversation busy: a job notification landing in that commit window is queued, then placed at the next boundary", async () => {
	// post_tools creates the continuation in its own terminal batch; a write during that batch sees busy.
	const gate = new Gate();
	const host = fakeHost();
	let inbox: unknown;
	const k = defineTask<null, { phase: "x" }, null, null, null>({
		name: "peek",
		async initial(_t, rt, c) {
			inbox = await rt.commit(
				(tx, cur) => [
					tx.snapshot({ doc: "sticky", conversationId: cur.conversationId }).inbox.length,
					tx.snapshot({ doc: "sticky", conversationId: cur.conversationId }).turn.tools.length,
				],
				c,
			);
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
	const env = await open({
		tools: [
			{
				name: "slow",
				description: "",
				parameters: Type.Object({ v: Type.String() }),
				async execute(_a, _api, c) {
					await gate.wait(c);
					return { content: [{ type: "text", text: "ok" }] };
				},
			},
		],
		processHost: host,
		taskKinds: [k],
	});
	onTestFinished(() => env.close());
	const a = await env.root.send({ content: "tool:slow" }, ctx);
	await gate.arrivals(1);
	// while the tool runs (busy), a job finishes and wants to notify
	const job = await env.root.commit(
		(tx) =>
			tx.createTask(
				kinds.job,
				{ command: "x", args: [], cwd: "/", notify: true, rerun: false },
				{ conversationId: 1, background: true },
			),
		ctx,
	);
	await new Promise((r) => setTimeout(r, 30));
	host.exit(`${job.id}:1`, 0);
	await env.h.waitForTask(job.id, ctx);
	assert.equal((await env.root.sticky(ctx)).inbox.length, 1); // queued: the turn is busy
	gate.open();
	await a.wait(ctx);
	assert.deepEqual((await env.root.sticky(ctx)).inbox, []); // placed at the post-tools boundary
	const ks = (await env.entries()).map((e) => e.kind.replace("pi.", ""));
	assert.ok(
		ks.indexOf("notice") > ks.indexOf("tool_result") && ks.indexOf("notice") < ks.lastIndexOf("assistant"),
		ks.join(" "),
	);
	void inbox;
});

test("nothing is stranded when the last turn task terminalizes: a write that arrives during the final closure lands in the transcript", async () => {
	const gate = new Gate();
	const env = await open({ models: fake({ respond: echoScript, gate }) });
	onTestFinished(() => env.close());
	const a = await env.root.send({ content: "A" }, ctx);
	await gate.arrivals(1);
	const w = await env.root.write({ kind: "note" }, ctx); // queued
	gate.open();
	await a.wait(ctx);
	assert.equal((await env.input(w))?.status, "done");
	assert.deepEqual((await env.root.sticky(ctx)).inbox, []);
});

// ---------------------------------------------------------------------------
// §6 phase-map contract
// ---------------------------------------------------------------------------

test("phase roles: a `next` transition into an in-flight phase is a contract fault → outcome faulted; the kind's declared failure type is never fabricated", async () => {
	const reports: unknown[] = [];
	const k = defineTask<null, { phase: "fly" } | { phase: "ok" }, null, { reason: "declared" }, null>({
		name: "roles",
		inflight: ["fly"],
		async initial() {
			return { next: { phase: "fly" } };
		},
		phases: {
			async fly() {
				return { done: () => ({ status: "failed", failure: { reason: "declared" } }) };
			},
			async ok() {
				return { done: () => ({ status: "completed", result: null }) };
			},
		},
		async abort() {
			return () => null;
		},
	});
	const env = await open({ taskKinds: [k], onReport: (e) => reports.push(e) });
	onTestFinished(() => env.close());
	const ref = await env.root.commit((tx) => tx.createTask(k, null, { conversationId: 1, background: true }), ctx);
	const t = await env.h.waitForTask(ref.id, ctx);
	assert.equal(t.outcome?.status, "faulted");
	assert.match((t.outcome as { error: string }).error, /in-flight phase fly/);
	assert.ok(reports[0] instanceof TaskContractFault);
});

test("an in-flight phase written with rt.commit before the effect is entered after reopen only", async () => {
	const entered: string[] = [];
	const gate = new Gate();
	const k = defineTask<null, { phase: "fly" }, null, null, null>({
		name: "fly",
		inflight: ["fly"],
		async initial(_t, rt, c) {
			await rt.commit((tx) => tx.checkpoint({ phase: "fly" }), c);
			entered.push("initial");
			await gate.wait(c);
			return { done: () => ({ status: "completed", result: null }) };
		},
		phases: {
			async fly() {
				entered.push("fly");
				return { done: () => ({ status: "completed", result: null }) };
			},
		},
		async abort() {
			return () => null;
		},
	});
	let env = await open({ backend: "jsonl", taskKinds: [k] });
	onTestFinished(() => env.close());
	const ref = await env.root.commit((tx) => tx.createTask(k, null, { conversationId: 1, background: true }), ctx);
	await gate.arrivals(1);
	await env.crash();
	env = await open({ dir: env.dir, backend: "jsonl", taskKinds: [k] });
	await env.h.waitForTask(ref.id, ctx);
	assert.deepEqual(entered, ["initial", "fly"]);
});

test("an ordinary kind that throws, or returns an invalid step/completion, ends faulted (not a declared failure); the task stays readable", async () => {
	const reports: unknown[] = [];
	const thrower = defineTask<null, { phase: "x" }, null, { reason: "declared" }, null>({
		name: "thrower",
		async initial() {
			throw new Error("kaboom");
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
	const badStep = defineTask<null, { phase: "x" }, null, null, null>({
		name: "badstep",
		async initial() {
			return { nope: true } as never;
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
	const badDone = defineTask<null, { phase: "x" }, null, null, null>({
		name: "baddone",
		async initial() {
			return { done: () => ({ status: "weird" }) as never };
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
	const badPhase = defineTask<null, { phase: "x" }, null, null, null>({
		name: "badphase",
		async initial() {
			return { next: { phase: "zzz" } as never };
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
	const env = await open({ taskKinds: [thrower, badStep, badDone, badPhase], onReport: (e) => reports.push(e) });
	onTestFinished(() => env.close());
	for (const [k, re] of [
		[thrower, /kaboom/],
		[badStep, /invalid step/],
		[badDone, /invalid completion/],
		[badPhase, /unknown phase zzz/],
	] as const) {
		const ref = await env.root.commit(
			(tx) => tx.createTask(k as typeof thrower, null, { conversationId: 1, background: true }),
			ctx,
		);
		const t = await env.h.waitForTask(ref.id, ctx);
		assert.equal(t.outcome?.status, "faulted", k.name);
		assert.match((t.outcome as { error: string }).error, re);
		assert.equal((await env.h.getTask(ref.id, ctx))?.status, "terminal");
	}
	assert.equal(reports.length, 4);
	assert.equal(resultOf(await env.h.getTask(1, ctx)), undefined);
});

test("transition builder may return a checkpoint, a completion, or 'retry' atomically", async () => {
	let tries = 0;
	const k = defineTask<null, { phase: "x" }, { done: true }, null, null>({
		name: "builder",
		async initial() {
			return {
				next: (_tx) => {
					tries++;
					return tries < 3 ? "retry" : { phase: "x" };
				},
			};
		},
		phases: {
			async x() {
				return { next: () => ({ status: "completed", result: { done: true } }) };
			},
		},
		async abort() {
			return () => null;
		},
	});
	const env = await open({ taskKinds: [k] });
	onTestFinished(() => env.close());
	const ref = await env.root.commit((tx) => tx.createTask(k, null, { conversationId: 1, background: true }), ctx);
	const t = await env.h.waitForTask(ref.id, ctx);
	assert.equal(tries, 3);
	assert.deepEqual(t.outcome, { status: "completed", result: { done: true } });
	void (null as unknown as Runtime);
});
