import assert from "node:assert/strict";
import type { Context } from "@earendil-works/chord";
import { onTestFinished, test } from "vitest";
import { kinds as kindsOf } from "../../../src/harness/pico3/harness.ts";
import type { RequestMessage } from "../../../src/harness/pico3/types.ts";
import {
	contentOf,
	ctx,
	echoScript,
	fake,
	fakeHost,
	Gate,
	kinds,
	model,
	open,
	sleep,
	tool,
	untilPhase,
	untilTerminal,
} from "./helpers.ts";

// Every test here: run until a specific durable phase, crash (close without writing),
// reopen on the same JSONL dir, resume, assert the turn completes correctly.

test("crash in generation@requesting → pi.usage{interrupted}, retry, complete", async () => {
	const gate = new Gate();
	let env = await open({ backend: "jsonl", models: fake({ respond: echoScript, gate }) });
	onTestFinished(() => env.close());
	const a = await env.root.send({ content: "A", requestId: "r" }, ctx);
	await untilPhase(env, "pi.generation", "requesting");
	await gate.arrivals(1);
	await env.crash();
	const models2 = fake({ respond: echoScript });
	env = await open({ dir: env.dir, backend: "jsonl", models: models2 });
	// The requestId still resolves to the original input across the reopen.
	const same = await env.root.send({ content: "dup", requestId: "r" }, ctx);
	assert.equal(same.id, a.id);
	const r = await same.wait(ctx);
	assert.equal(r.status, "done");
	assert.equal(kinds(await env.entries()), "user system usage assistant");
	assert.deepEqual((await env.entries())[2]!.data, { attempt: 1, error: "interrupted" });
	assert.equal(models2.calls, 1);
});

test("crash in generation@prepared (blocked in beforeRequest) → hooks rerun, no duplicate system entry", async () => {
	const gate = new Gate();
	let hookCalls = 0;
	const hooks = {
		generation: {
			beforeRequest: async (_req: unknown, _i: unknown, c: Context) => {
				hookCalls++;
				await gate.wait(c);
				return undefined;
			},
		},
	};
	let env = await open({ backend: "jsonl", hooks });
	onTestFinished(() => env.close());
	const a = await env.root.send({ content: "A" }, ctx);
	await untilPhase(env, "pi.generation", "prepared");
	await gate.arrivals(1);
	await env.crash();
	gate.open();
	env = await open({ dir: env.dir, backend: "jsonl", hooks });
	await env.root.waitForIdle(ctx);
	assert.equal(hookCalls, 2); // rerun on recovery
	const entries = await env.entries();
	assert.equal(entries.filter((e) => e.kind === "pi.system").length, 1); // step 1 never reruns
	assert.equal(entries.filter((e) => e.kind === "pi.usage").length, 0); // prepared is not an in-flight effect: no failed attempt recorded
	assert.equal((await env.input(a.id))?.status, "done");
});

test("crash in generation@retrying → sleeps out untilMs, then retries", async () => {
	let n = 0;
	const models = fake({ respond: (m) => (n++ === 0 ? { error: "overloaded" } : echoScript(m)) });
	let env = await open({
		backend: "jsonl",
		models,
		root: { rewindable: { model }, sticky: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 300 } } },
	});
	onTestFinished(() => env.close());
	const a = await env.root.send({ content: "A" }, ctx);
	const t = await untilPhase(env, "pi.generation", "retrying");
	const untilMs = (t.checkpoint as unknown as { untilMs: number }).untilMs;
	await env.crash();
	const models2 = fake({ respond: echoScript });
	env = await open({ dir: env.dir, backend: "jsonl", models: models2 });
	await env.root.waitForIdle(ctx);
	assert.ok(Date.now() >= untilMs, "waited out the durable deadline");
	assert.equal((await env.input(a.id))?.status, "done");
	assert.equal(models2.calls, 1);
	assert.equal(kinds(await env.entries()), "user system usage assistant");
});

test("crash in tool@started with replay:safe → tool re-invoked; unsafe → synthetic interrupted result", async () => {
	for (const replay of ["safe", "unsafe"] as const) {
		const gate = new Gate();
		const t = tool("x", { replay, gate });
		let env = await open({ backend: "jsonl", tools: [t] });
		onTestFinished(() => env.close().catch(() => {}));
		const a = await env.root.send({ content: "tool:x" }, ctx);
		await untilPhase(env, "pi.tool", "started");
		await gate.arrivals(1);
		await env.crash();
		const t2 = tool("x", { replay });
		env = await open({ dir: env.dir, backend: "jsonl", tools: [t2] });
		await env.root.waitForIdle(ctx); // `a` belongs to the crashed harness; handles do not survive a reopen
		assert.equal((await env.input(a.id))?.status, "done");
		const result = (await env.entries()).find((e) => e.kind === "pi.tool_result")!;
		if (replay === "safe") {
			assert.equal(t2.calls, 1);
			assert.match(contentOf(result), /x\(x\)/);
		} else {
			assert.equal(t2.calls, 0);
			assert.match(contentOf(result), /interrupted/);
		}
		assert.equal(kinds(await env.entries()), "user system assistant tool_result assistant");
		await env.close();
	}
});

test("crash in tool before `started` (blocked in beforeTool) → hook reruns, tool runs once", async () => {
	const gate = new Gate();
	const t = tool("x");
	let hookCalls = 0;
	const hooks = {
		tool: {
			beforeTool: async (_c: unknown, _i: unknown, c: Context) => {
				hookCalls++;
				await gate.wait(c);
				return undefined;
			},
		},
	};
	let env = await open({ backend: "jsonl", tools: [t], hooks });
	onTestFinished(() => env.close());
	const a = await env.root.send({ content: "tool:x" }, ctx);
	await untilPhase(env, "pi.tool", undefined);
	await gate.arrivals(1);
	await env.crash();
	gate.open();
	const t2 = tool("x");
	env = await open({ dir: env.dir, backend: "jsonl", tools: [t2], hooks });
	await env.root.waitForIdle(ctx);
	assert.equal(hookCalls, 2);
	assert.equal(t2.calls, 1);
	assert.equal((await env.input(a.id))?.status, "done");
});

test("crash while post_tools is running (blocked in afterTools) → reruns from initial, continuation runs once", async () => {
	const gate = new Gate();
	let hookCalls = 0;
	const hooks = {
		postTools: {
			afterTools: async (_a: unknown, _r: unknown, _i: unknown, c: Context) => {
				hookCalls++;
				await gate.wait(c);
			},
		},
	};
	let env = await open({ backend: "jsonl", tools: [tool("x")], hooks });
	onTestFinished(() => env.close());
	const a = await env.root.send({ content: "tool:x" }, ctx);
	await gate.arrivals(1); // post_tools is running, no checkpoint
	const live = (await env.tasks()).filter((t) => t.status !== "terminal");
	assert.deepEqual(
		live.map((t) => t.kind),
		["pi.post_tools"],
	);
	await env.crash();
	gate.open();
	env = await open({ dir: env.dir, backend: "jsonl", tools: [tool("x")], hooks });
	// at open: post_tools is live, its tools are retained (referenced by `after`), the old generation is pruned
	const atOpen = await env.tasks();
	assert.deepEqual(
		atOpen
			.filter((t) => t.kind !== "pi.generation")
			.map((t) => `${t.kind.replace("pi.", "")}:${t.status}`)
			.sort(),
		["post_tools:running", "tool:terminal"],
	);
	await env.root.waitForIdle(ctx);
	assert.equal(hookCalls, 2);
	assert.equal((await env.input(a.id))?.status, "done");
	assert.equal(kinds(await env.entries()), "user system assistant tool_result assistant");
	const pt = (await env.tasks()).find((t) => t.kind === "pi.post_tools")!;
	assert.equal((await env.tasks()).filter((t) => t.kind === "pi.generation" && t.id > pt.id).length, 1); // exactly one continuation (the original generation is retained: no pruning)
});

test("crash in collapse@summarizing → counted as a failed attempt, retried, summary lands", async () => {
	const gate = new Gate();
	const isSummary = (m: RequestMessage[]) =>
		m.some((x) => x.role === "user" && String((x as { content: unknown }).content).startsWith("Summarize"));
	let env = await open({
		backend: "jsonl",
		models: fake({ respond: (m) => (isSummary(m) ? { text: "the summary" } : echoScript(m)), gate }),
		root: {
			rewindable: { model, keepRecent: 10 },
			sticky: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		},
	});
	onTestFinished(() => env.close());
	gate.open();
	for (const t of ["one", "two", "three"]) await (await env.root.send({ content: t }, ctx)).wait(ctx);
	gate.close();
	const cid = await env.root.collapse(undefined, ctx);
	await untilPhase(env, "pi.collapse", "summarizing");
	await gate.arrivals(4);
	await env.crash();
	env = await open({
		dir: env.dir,
		backend: "jsonl",
		models: fake({ respond: (m) => (isSummary(m) ? { text: "the summary" } : echoScript(m)) }),
	});
	const c = await untilTerminal(env, cid);
	assert.equal(c.outcome?.status, "completed");
	const summary = (await env.entries()).find((e) => e.kind === "pi.summary")!;
	assert.equal(contentOf(summary), "the summary ");
	assert.ok(summary.head! > 0);
});

test("crash in job@spawning / @running → host.status decides; unknown+rerun restarts with the same key", async () => {
	const host = fakeHost();
	let env = await open({ backend: "jsonl", processHost: host });
	onTestFinished(() => env.close());
	const jobId = await env.root.commit(
		(tx) =>
			tx.createTask(
				kindsOf.job,
				{ command: "x", args: [], cwd: "/", notify: true, rerun: true },
				{ conversationId: 1, background: true },
			).id,
		ctx,
	);
	const running = await untilPhase(env, "pi.job", "running");
	const key = (running.checkpoint as unknown as { key: string }).key;
	assert.equal(host.startCalls, 1);
	await env.crash();

	// Reopen with a host that forgot the process: unknown + rerun → start again, same key.
	const host2 = fakeHost();
	env = await open({ dir: env.dir, backend: "jsonl", processHost: host2 });
	await sleep(50);
	assert.equal(host2.startCalls, 1);
	assert.ok(host2.procs.has(key));
	host2.exit(key, 0);
	const done = await untilTerminal(env, jobId);
	assert.deepEqual(done.outcome, {
		status: "completed",
		result: { exitCode: 0, occurrences: 1, stdout: `out ${key}`, stderr: "" },
	});
	// notice was written (idle conversation → appended immediately)
	assert.equal(kinds(await env.entries()), "notice");
});

test("job with rerun:false and unknown after crash → failed/interrupted", async () => {
	const host = fakeHost();
	let env = await open({ backend: "jsonl", processHost: host });
	onTestFinished(() => env.close());
	const jobId = await env.root.commit(
		(tx) =>
			tx.createTask(
				kindsOf.job,
				{ command: "x", args: [], cwd: "/", notify: false, rerun: false },
				{ conversationId: 1, background: true },
			).id,
		ctx,
	);
	await untilPhase(env, "pi.job", "running");
	await env.crash();
	env = await open({ dir: env.dir, backend: "jsonl", processHost: fakeHost() });
	assert.equal(
		((await untilTerminal(env, jobId)).outcome as unknown as { failure: { reason: string } }).failure.reason,
		"interrupted",
	);
});

test("reopen with a marked task runs abort, not run", async () => {
	const gate = new Gate();
	let env = await open({ backend: "jsonl", models: fake({ respond: echoScript, gate }) });
	onTestFinished(() => env.close());
	const a = await env.root.send({ content: "A" }, ctx);
	const t = await untilPhase(env, "pi.generation", "requesting");
	await gate.arrivals(1);
	// Mark durably, then crash before the fresh abort gets to run.
	await env.h.markTask(t.id, ctx);
	await env.crash();
	const models2 = fake({ respond: echoScript });
	env = await open({ dir: env.dir, backend: "jsonl", models: models2 });
	assert.equal((await untilTerminal(env, t.id)).outcome?.status, "aborted");
	assert.equal(models2.calls, 0); // never re-requested
	assert.equal((await env.input(a.id))?.reason, "aborted");
});

test("memory vs jsonl: identical transcripts and outcomes for the same script", async () => {
	const results: string[] = [];
	for (const backend of ["memory", "jsonl"] as const) {
		const t = tool("a");
		const env = await open({ backend, tools: [t] });
		onTestFinished(() => env.close().catch(() => {}));
		for (const c of ["tool:a", "plain", "tool:a"]) await (await env.root.send({ content: c }, ctx)).wait(ctx);
		await env.root.waitForIdle(ctx);
		results.push(
			`${kinds(await env.entries())}|${(await env.tasks()).map((x) => `${x.kind}:${x.outcome?.status}`).join(",")}`,
		);
		await env.close();
	}
	assert.equal(results[0], results[1]);
});
