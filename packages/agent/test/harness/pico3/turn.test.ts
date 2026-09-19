import assert from "node:assert/strict";
import { onTestFinished, test } from "vitest";
import { effectiveTools } from "../../../src/harness/pico3/system.ts";
import { contentOf, ctx, echoScript, fake, Gate, kinds, open, sleep, tool } from "./helpers.ts";

for (const backend of ["memory", "jsonl"] as const) {
	test(`[${backend}] one turn: user → generation → 2 tools → post_tools → generation → final`, async () => {
		const a = tool("a"),
			b = tool("b");
		const env = await open({ backend, tools: [a, b] });
		onTestFinished(() => env.close());
		const inp = await env.root.send({ content: "tool:a,b" }, ctx);
		const r = await inp.wait(ctx);
		await env.root.waitForIdle(ctx);

		assert.equal(r.status, "done");
		assert.equal(kinds(await env.entries()), "user system assistant tool_result tool_result assistant");
		assert.equal(a.calls, 1);
		assert.equal(b.calls, 1);
		const tasks = await env.tasks();
		assert.deepEqual(tasks.map((t) => `${t.kind}:${t.status}:${t.outcome?.status}`).sort(), [
			"pi.generation:terminal:completed",
			"pi.generation:terminal:completed",
			"pi.post_tools:terminal:completed",
			"pi.tool:terminal:completed",
			"pi.tool:terminal:completed",
		]);
		const answer = (await env.entries()).find((e) => e.id === r.answer)!;
		assert.equal(contentOf(answer), JSON.stringify([{ type: "text", text: "after tools " }]));
		// tool results are in call order in the projection
		const { messages } = await env.root.commit((tx) => tx.context(1), ctx);
		assert.deepEqual(
			messages.map((m) => m.role),
			["user", "system", "assistant", "toolResult", "toolResult", "assistant"],
		); // system is appended at preparation, after the user entry (§12.5)
		// turn view cleared
		assert.deepEqual((await env.root.sticky(ctx)).turn, { tools: [] });
		assert.deepEqual((await env.root.sticky(ctx)).tasks, {});
		await env.close();
	});
}

test("requestId dedup returns the original input and writes nothing", async () => {
	const env = await open({});
	onTestFinished(() => env.close());
	const a = await env.root.send({ content: "hi", requestId: "k" }, ctx);
	const b = await env.root.send({ content: "other", requestId: "k" }, ctx);
	assert.equal(a.id, b.id);
	await a.wait(ctx);
	assert.equal((await env.entries()).filter((e) => e.kind === "pi.user").length, 1);
});

test("whenBusy: followUp queues, steer queues, reject throws; idle send places", async () => {
	const gate = new Gate();
	const env = await open({ models: fake({ respond: echoScript, gate }) });
	onTestFinished(() => env.close());
	const first = await env.root.send({ content: "A" }, ctx);
	await gate.arrivals(1);
	const f = await env.root.send({ content: "F" }, ctx);
	const s = await env.root.send({ content: "S", whenBusy: "steer" }, ctx);
	await assert.rejects(env.root.send({ content: "R", whenBusy: "reject" }, ctx), /busy/i);
	assert.equal((await env.input(f.id))?.status, "queued");
	assert.equal((await env.input(s.id))?.status, "queued");
	const sticky = await env.root.sticky(ctx);
	assert.deepEqual(
		sticky.inbox.map((q) => q.mode),
		["followUp", "steer"],
	);
	gate.open();
	await first.wait(ctx);
	await env.root.waitForIdle(ctx);
	// A answered; S placed at the final boundary too (no post-tools boundary in a no-tool turn); F placed. Both form the successor group.
	assert.equal((await env.input(f.id))?.status, "done");
	assert.equal((await env.input(s.id))?.status, "done");
	assert.equal(kinds(await env.entries()), "user system assistant user user assistant");
});

test("steer joins the active group at the post-tools boundary; followUp waits for the final answer", async () => {
	const gate = new Gate();
	const t = tool("a", { gate });
	const env = await open({ tools: [t] });
	onTestFinished(() => env.close());
	const first = await env.root.send({ content: "tool:a" }, ctx);
	await gate.arrivals(1); // tool running: generation done, post_tools pending
	const s = await env.root.send({ content: "S", whenBusy: "steer" }, ctx);
	const f = await env.root.send({ content: "F" }, ctx);
	gate.open();
	await first.wait(ctx);
	await env.root.waitForIdle(ctx);
	const entries = await env.entries();
	// S placed right after the tool results (before the continuation generation), F after the final answer
	assert.equal(kinds(entries), "user system assistant tool_result user assistant user assistant");
	const sEntry = (await env.input(s.id))!;
	const fEntry = (await env.input(f.id))!;
	assert.equal(sEntry.status, "done");
	assert.equal(fEntry.status, "done");
	assert.ok(sEntry.entry! < fEntry.entry!);
	// S's answer is the continuation's answer, which is also A's answer
	assert.equal((await env.input(first.id))?.answer, sEntry.answer);
	assert.notEqual(sEntry.answer, fEntry.answer);
});

test("one-at-a-time vs all followUp modes", async () => {
	for (const mode of ["one-at-a-time", "all"] as const) {
		const gate = new Gate();
		const env = await open({
			models: fake({ respond: echoScript, gate }),
			root: { rewindable: { model }, sticky: { followUpMode: mode } },
		});
		onTestFinished(() => env.close().catch(() => {}));
		const a = await env.root.send({ content: "A" }, ctx);
		await gate.arrivals(1);
		const f1 = await env.root.send({ content: "F1" }, ctx);
		const f2 = await env.root.send({ content: "F2" }, ctx);
		gate.open();
		await a.wait(ctx);
		await env.root.waitForIdle(ctx);
		const gens = (await env.tasks()).filter((t) => t.kind === "pi.generation");
		const secondGroup = (gens[1]!.input as { inputs: number[] }).inputs;
		if (mode === "all") assert.deepEqual(secondGroup, [f1.id, f2.id]);
		else {
			assert.deepEqual(secondGroup, [f1.id]);
			assert.deepEqual((gens[2]!.input as { inputs: number[] }).inputs, [f2.id]); // F2 placed at the idle-turn boundary after F1's answer
		}
		assert.equal((await env.input(f2.id))?.status, "done");
		await env.close();
	}
});
const model = { provider: "anthropic", modelId: "fake-1" };

test("write: appended when idle, queued when busy, placed at the next boundary, done without an answer", async () => {
	const gate = new Gate();
	const env = await open({ models: fake({ respond: echoScript, gate }) });
	onTestFinished(() => env.close());
	const w0 = await env.root.write(
		{ kind: "pi.notice", model: [{ role: "user", content: "idle note", timestamp: 0 }] },
		ctx,
	);
	assert.equal((await env.input(w0))?.status, "done");
	const a = await env.root.send({ content: "A" }, ctx);
	await gate.arrivals(1);
	const w1 = await env.root.write(
		{ kind: "pi.notice", model: [{ role: "user", content: "busy note", timestamp: 0 }] },
		ctx,
	);
	assert.equal((await env.input(w1))?.status, "queued");
	gate.open();
	await a.wait(ctx);
	await env.root.waitForIdle(ctx);
	assert.equal((await env.input(w1))?.status, "done");
	assert.equal((await env.input(w1))?.answer, undefined);
	assert.equal(kinds(await env.entries()), "notice user system assistant notice");
});

test("InputHandle.abort: queued → aborted and removed; placed → already_placed; unknown → not_found", async () => {
	const gate = new Gate();
	const env = await open({ models: fake({ respond: echoScript, gate }) });
	onTestFinished(() => env.close());
	const a = await env.root.send({ content: "A" }, ctx);
	await gate.arrivals(1);
	const f = await env.root.send({ content: "F" }, ctx);
	assert.equal(await f.abort(ctx), "aborted");
	assert.equal((await env.input(f.id))?.status, "unanswered");
	assert.equal((await env.root.sticky(ctx)).inbox.length, 0);
	assert.equal(await a.abort(ctx), "already_placed");
	assert.equal(await env.input(99999), undefined);
	gate.open();
	await a.wait(ctx);
});

test("reset while busy stales every earlier queued steer/followUp; later ones run in the fresh context", async () => {
	const gate = new Gate();
	const env = await open({ models: fake({ respond: echoScript, gate }) });
	onTestFinished(() => env.close());
	const a = await env.root.send({ content: "A" }, ctx);
	await gate.arrivals(1);
	const b1 = await env.root.send({ content: "B1" }, ctx);
	const b2 = await env.root.send({ content: "B2" }, ctx);
	await env.root.reset(undefined, ctx);
	const c = await env.root.send({ content: "C" }, ctx); // admitted after the reset
	gate.open();
	await a.wait(ctx);
	await c.wait(ctx);
	await env.root.waitForIdle(ctx);
	assert.equal((await env.input(b1.id))?.reason, "stale");
	assert.equal((await env.input(b2.id))?.reason, "stale");
	assert.equal((await env.input(c.id))?.status, "done");
	const { entries } = await env.root.commit((tx) => tx.context(1), ctx);
	assert.equal(kinds(entries), "reset* user system assistant"); // C in the fresh context, with a fresh system baseline
});

test("handoff via tool control ends the turn with a head; a queued followUp starts in the fresh context", async () => {
	const gate = new Gate();
	const hand = tool("hand", { gate, result: { control: { handoff: "fresh" } } });
	const env = await open({ tools: [hand] });
	onTestFinished(() => env.close());
	const a = await env.root.send({ content: "tool:hand" }, ctx);
	await gate.arrivals(1);
	const f = await env.root.send({ content: "F" }, ctx);
	gate.open();
	await a.wait(ctx);
	await f.wait(ctx);
	await env.root.waitForIdle(ctx);
	const post = (await env.tasks()).find((t) => t.kind === "pi.post_tools")!;
	assert.equal((post.outcome as unknown as { result: { ended: string } }).result.ended, "handoff");
	assert.equal((await env.input(a.id))?.status, "done");
	assert.equal((await env.input(a.id))?.answer, (await env.entries()).find((e) => e.kind === "pi.assistant")!.id);
	const { entries } = await env.root.commit((tx) => tx.context(1), ctx);
	assert.equal(kinds(entries), "handoff* user system assistant");
});

test("terminate via tool control ends the turn without a head", async () => {
	const t = tool("t", { result: { control: { terminate: true } } });
	const env = await open({ tools: [t] });
	onTestFinished(() => env.close());
	const a = await env.root.send({ content: "tool:t" }, ctx);
	await a.wait(ctx);
	await env.root.waitForIdle(ctx);
	assert.equal(kinds(await env.entries()), "user system assistant tool_result"); // no continuation generation
	assert.equal((await env.tasks()).filter((t) => t.kind === "pi.generation").length, 1);
});

test("addTools control extends selectedTools before the continuation", async () => {
	const t = tool("t", { result: { control: { addTools: ["extra"] } } });
	const extra = tool("extra");
	const env = await open({ tools: [t, extra], root: { rewindable: { model, selectedTools: ["t"] } } });
	onTestFinished(() => env.close());
	const a = await env.root.send({ content: "tool:t" }, ctx);
	await a.wait(ctx);
	assert.deepEqual((await env.root.rewindable(ctx)).selectedTools, ["t", "extra"]);
	const sys = (await env.entries()).filter((e) => e.kind === "pi.system");
	assert.equal(sys.length, 2); // loadout changed → a delta before the continuation, listing only what was added
	assert.deepEqual(
		(sys[1]!.model![0] as { toolsAdded: { name: string }[] }).toolsAdded.map((t) => t.name),
		["extra"],
	);
	assert.equal((sys[1]!.model![0] as { toolsRemoved?: unknown[] }).toolsRemoved, undefined);
	const { messages } = await env.root.commit((tx) => tx.context(1), ctx);
	assert.deepEqual(
		effectiveTools(messages).map((t) => t.name),
		["t", "extra"],
	);
});

test("retryable provider error: pi.usage recorded, retried, then succeeds", async () => {
	let n = 0;
	const models = fake({ respond: (m) => (n++ === 0 ? { error: "overloaded" } : echoScript(m)) });
	const env = await open({
		models,
		root: { rewindable: { model }, sticky: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } },
	});
	onTestFinished(() => env.close());
	const a = await env.root.send({ content: "A" }, ctx);
	const r = await a.wait(ctx);
	assert.equal(r.status, "done");
	assert.equal(kinds(await env.entries()), "user system usage assistant");
	assert.equal(models.calls, 2);
	assert.equal(((await env.entries())[2]!.data as { attempt: number }).attempt, 1);
});

test("retries exhausted → failed/retries_exhausted, inputs unanswered/failed, display-only assistant entry", async () => {
	const models = fake({ respond: () => ({ error: "overloaded" }) });
	const env = await open({
		models,
		root: { rewindable: { model }, sticky: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } } },
	});
	onTestFinished(() => env.close());
	const a = await env.root.send({ content: "A" }, ctx);
	const r = await a.wait(ctx);
	assert.equal(r.status, "unanswered");
	assert.equal(r.reason, "failed");
	const gen = (await env.tasks()).find((t) => t.kind === "pi.generation")!;
	assert.equal((gen.outcome as unknown as { failure: { reason: string } }).failure.reason, "retries_exhausted");
	assert.equal(models.calls, 2); // initial + 1 retry
	assert.equal(kinds(await env.entries()), "user system usage assistant");
	const { messages } = await env.root.commit((tx) => tx.context(1), ctx);
	assert.equal(messages.filter((m) => m.role === "assistant").length, 0); // display-only: never in context
	const shown = (await env.entries()).find((e) => e.kind === "pi.assistant")!;
	assert.equal(shown.model, undefined);
	assert.equal((shown.data as { reason: string }).reason, "error");
});

test("retry disabled → failed/provider immediately", async () => {
	const models = fake({ respond: () => ({ error: "boom" }) });
	const env = await open({
		models,
		root: { rewindable: { model }, sticky: { retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 } } },
	});
	onTestFinished(() => env.close());
	const a = await env.root.send({ content: "A" }, ctx);
	await a.wait(ctx);
	const gen = (await env.tasks()).find((t) => t.kind === "pi.generation")!;
	assert.equal((gen.outcome as unknown as { failure: { reason: string } }).failure.reason, "provider");
	assert.equal(models.calls, 1);
});

test("no model → failed/no_model, no provider call", async () => {
	const models = fake({ respond: echoScript });
	const env = await open({ models, root: { rewindable: {} } });
	onTestFinished(() => env.close());
	const a = await env.root.send({ content: "A" }, ctx);
	await a.wait(ctx);
	const gen = (await env.tasks()).find((t) => t.kind === "pi.generation")!;
	assert.equal((gen.outcome as unknown as { failure: { reason: string } }).failure.reason, "no_model");
	assert.equal(models.calls, 0);
});

test("yield continuation: onYield continues with a pi.user entry and the same input group", async () => {
	let yielded = 0;
	const env = await open({
		hooks: { generation: { onYield: () => (yielded++ === 0 ? { continue: "keep going" } : undefined) } },
	});
	onTestFinished(() => env.close());
	const a = await env.root.send({ content: "A" }, ctx);
	const r = await a.wait(ctx);
	await env.root.waitForIdle(ctx);
	assert.equal(kinds(await env.entries()), "user system assistant user assistant");
	const cont = (await env.entries())[3]!;
	assert.deepEqual(cont.data, { continuation: true, from: (await env.entries())[2]!.id });
	const gens = (await env.tasks()).filter((t) => t.kind === "pi.generation");
	assert.deepEqual(
		gens.map((g) => (g.input as { inputs: number[] }).inputs),
		[[a.id], [a.id]],
	);
	assert.equal(r.answer, (await env.entries())[4]!.id); // answered by the second generation
});

test("conversation abort mid-stream: task aborted with partial, inputs unanswered/aborted, steer withdrawn, write kept", async () => {
	const gate = new Gate();
	const env = await open({
		models: fake({
			respond: (messages, call) => (call === 0 ? { text: "partial ".repeat(100) } : echoScript(messages)),
			gate,
			tokenDelayMs: 5,
		}),
	});
	onTestFinished(() => env.close());
	const a = await env.root.send({ content: "A" }, ctx);
	await gate.arrivals(1);
	const s = await env.root.send({ content: "S", whenBusy: "steer" }, ctx);
	const w = await env.root.write({ kind: "pi.notice", model: [{ role: "user", content: "n", timestamp: 0 }] }, ctx);
	gate.open();
	for (let attempt = 0; attempt < 100; attempt++) {
		if (
			(await env.root.sticky(ctx)).turn.message?.content.some((part) => part.type === "text" && part.text.length > 0)
		)
			break;
		await sleep(5);
	}
	assert.ok((await env.root.sticky(ctx)).turn.message, "the abort must happen after streamed content");
	await env.root.abort(ctx);
	assert.equal((await env.input(a.id))?.reason, "aborted");
	assert.equal((await env.input(s.id))?.reason, "aborted");
	assert.equal((await env.input(w))?.status, "queued"); // writes survive conversation abort
	const gen = (await env.tasks()).find((t) => t.kind === "pi.generation")!;
	assert.equal(gen.outcome?.status, "aborted");
	const partial = (await env.entries()).find(
		(entry) => entry.kind === "pi.assistant" && (entry.data as { reason?: string } | undefined)?.reason === "aborted",
	)!;
	assert.equal(partial.model, undefined);
	assert.ok((partial.data as { display: { content: unknown[] } }).display.content.length > 0);
	assert.deepEqual(
		(await env.root.sticky(ctx)).inbox.map((q) => q.mode),
		["write"],
	);
	// next idle send places the surviving write first
	const b = await env.root.send({ content: "B" }, ctx);
	await b.wait(ctx);
	assert.equal(kinds(await env.entries()), "user system assistant notice user assistant");
});

test("overflow: collapse task + replacement generation with the same inputs", async () => {
	const models = fake({
		respond: (m) =>
			m.some((x) => x.role === "user" && String((x as { content: unknown }).content).startsWith("Summarize"))
				? { text: "summary text" }
				: echoScript(m),
	});
	const modelObj = models.resolve({ provider: "", modelId: "" })!;
	const env = await open({ models, root: { rewindable: { model, keepRecent: 100 } } });
	onTestFinished(() => env.close());
	// three turns of history, then shrink the window so the next request overflows
	for (const t of ["one", "two", "three"]) await (await env.root.send({ content: t }, ctx)).wait(ctx);
	(modelObj as { contextWindow: number }).contextWindow = 200;
	(modelObj as { maxTokens: number }).maxTokens = 10;
	const four = await env.root.send({ content: "four" }, ctx);
	const r = await four.wait(ctx);
	await env.root.waitForIdle(ctx);
	const tasks = await env.tasks();
	const collapse = tasks.find((t) => t.kind === "pi.collapse")!;
	assert.ok(collapse, "collapse created");
	assert.equal((collapse.input as { reason: string }).reason, "overflow");
	const gens = tasks.filter((t) => t.kind === "pi.generation");
	const overflowed = gens.find((g) => g.outcome?.status === "failed")!;
	assert.equal((overflowed.outcome as unknown as { failure: { reason: string } }).failure.reason, "overflow");
	const replacement = gens.find((g) => g.after.includes(collapse.id))!;
	assert.deepEqual((replacement.input as { inputs: number[] }).inputs, [four.id]);
	assert.equal(r.status, "done");
	assert.ok((await env.entries()).some((e) => e.kind === "pi.summary"));
});
