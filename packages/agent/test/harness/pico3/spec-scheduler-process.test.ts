import assert from "node:assert/strict";
import { onTestFinished, test, vi } from "vitest";
import { kinds } from "../../../src/harness/pico3/harness.ts";
import { CollapseInProgress, defineTask, type ProcessHost } from "../../../src/harness/pico3/types.ts";
import { contentOf, ctx, echoScript, fake, Gate, model, open, tool, untilPhase } from "./helpers.ts";

test("terminal generation failure drains passive writes and settles every queued trigger through successor groups", async () => {
	const gate = new Gate();
	const models = fake({ respond: () => ({ error: "provider down" }), gate });
	const env = await open({
		models,
		root: {
			rewindable: { model },
			sticky: {
				retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
				followUpMode: "all",
				steeringMode: "all",
			},
		},
	});
	onTestFinished(() => env.close());
	const first = await env.root.send({ content: "first" }, ctx);
	await gate.arrivals(1);
	const followA = await env.root.send({ content: "follow-a" }, ctx);
	const steer = await env.root.send({ content: "steer", whenBusy: "steer" }, ctx);
	const followB = await env.root.send({ content: "follow-b" }, ctx);
	const passive = await env.root.write({ kind: "passive.note", data: { durable: true } }, ctx);
	await env.root.config.reset(["model"], ctx);
	gate.open();

	const settled = await Promise.all([first.wait(ctx), followA.wait(ctx), steer.wait(ctx), followB.wait(ctx)]);
	assert.deepEqual(
		settled.map((input) => input.status),
		["unanswered", "unanswered", "unanswered", "unanswered"],
	);
	assert.deepEqual(
		settled.map((input) => input.reason),
		["failed", "failed", "failed", "failed"],
	);
	assert.equal((await env.input(passive))?.status, "done");
	assert.deepEqual((await env.root.sticky(ctx)).inbox, []);
	const generations = (await env.tasks()).filter((task) => task.kind === "pi.generation");
	assert.equal(generations.length, 2, "all three queued triggers form one successor input group");
	assert.deepEqual(
		generations.map((task) =>
			task.outcome?.status === "failed" ? (task.outcome.failure as { reason: string }).reason : task.outcome?.status,
		),
		["provider", "no_model"],
	);
	assert.equal(models.calls, 1);
});

test("display-only provider errors remain visible in history but never enter the next provider request", async () => {
	let call = 0;
	const models = fake({ respond: (messages) => (call++ === 0 ? { error: "fatal" } : echoScript(messages)) });
	const env = await open({
		models,
		root: {
			rewindable: { model },
			sticky: { retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 } },
		},
	});
	onTestFinished(() => env.close());
	const failed = await (await env.root.send({ content: "first" }, ctx)).wait(ctx);
	assert.equal(failed.reason, "failed");
	const display = (await env.entries()).find(
		(entry) => entry.kind === "pi.assistant" && (entry.data as { reason?: string } | undefined)?.reason === "error",
	)!;
	assert.equal(display.model, undefined);
	assert.ok((display.data as { display?: unknown }).display !== undefined);

	const second = await (await env.root.send({ content: "second" }, ctx)).wait(ctx);
	assert.equal(second.status, "done");
	assert.equal(models.requests.length, 2);
	assert.ok(
		!models.requests[1]!.some(
			(message) =>
				message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted"),
		),
	);
	assert.doesNotMatch(JSON.stringify(models.requests[1]), /fatal/);
});

test("generation singleton serializes concurrent admissions and permits a new generation after terminal retention", async () => {
	const gate = new Gate();
	const env = await open({ models: fake({ respond: echoScript, gate }) });
	onTestFinished(() => env.close());
	const first = await env.root.send({ content: "one" }, ctx);
	await gate.arrivals(1);
	const [second, third] = await Promise.all([
		env.root.send({ content: "two" }, ctx),
		env.root.send({ content: "three" }, ctx),
	]);
	const during = (await env.tasks()).filter((task) => task.kind === "pi.generation" && task.status !== "terminal");
	assert.equal(during.length, 1);
	assert.deepEqual((during[0]!.input as { inputs: number[] }).inputs, [first.id]);
	gate.open();
	await Promise.all([first.wait(ctx), second.wait(ctx), third.wait(ctx)]);
	await env.root.waitForIdle(ctx);
	const retained = (await env.tasks()).filter((task) => task.kind === "pi.generation");
	assert.equal(retained.length, 3);
	assert.equal(
		retained.every((task) => task.status === "terminal"),
		true,
	);
	const fourth = await env.root.send({ content: "four" }, ctx);
	assert.equal((await fourth.wait(ctx)).status, "done");
});

test("collapse singleton rejects overlap before persistence and can be recreated after the retained terminal task", async () => {
	const collapseGate = new Gate();
	const summary = (messages: Parameters<typeof echoScript>[0]) =>
		messages.some(
			(message) =>
				message.role === "user" &&
				String((message as { content?: unknown }).content).includes("Respond with the summary only"),
		)
			? { text: "summary" }
			: echoScript(messages);
	const env = await open({
		models: fake({ respond: summary }),
		root: { rewindable: { model, keepRecent: 1 } },
		hooks: {
			collapse: {
				beforeCollapse: async (_reason, _through, _entries, _info, context) => {
					await collapseGate.wait(context);
				},
			},
		},
	});
	onTestFinished(() => env.close());
	for (const prompt of ["one", "two", "three"]) await (await env.root.send({ content: prompt }, ctx)).wait(ctx);
	const first = await env.root.collapse(undefined, ctx);
	await collapseGate.arrivals(1);
	await assert.rejects(env.root.collapse(undefined, ctx), CollapseInProgress);
	collapseGate.open();
	const retained = await env.h.waitForTask(first, ctx);
	assert.equal(retained.status, "terminal");
	assert.equal((await env.h.getTask(first, ctx))?.id, first);
});

test("job spawn failure terminalizes, retains its declared failure, and appends an idle notification without poisoning inbox", async () => {
	const host: ProcessHost = {
		async start() {
			throw new Error("spawn denied");
		},
		async status() {
			return { status: "unknown" };
		},
		async kill() {},
	};
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
	const terminal = await env.h.waitForTask(ref.id, ctx);
	assert.deepEqual(terminal.outcome, {
		status: "failed",
		failure: { reason: "spawn", detail: "Error: spawn denied" },
	});
	assert.deepEqual((await env.root.sticky(ctx)).inbox, []);
	assert.match(contentOf((await env.entries()).find((entry) => entry.kind === "pi.notice")), /failed to start/);
});

test("job host status failure reconciles to interrupted without rerunning the process", async () => {
	let starts = 0;
	const host: ProcessHost = {
		async start() {
			starts++;
		},
		async status() {
			throw new Error("host unavailable");
		},
		async kill() {},
	};
	const env = await open({ processHost: host });
	onTestFinished(() => env.close());
	const ref = await env.root.commit(
		(tx) =>
			tx.createTask(
				kinds.job,
				{ command: "x", args: [], cwd: "/", notify: false, rerun: true },
				{ conversationId: 1, background: true },
			),
		ctx,
	);
	const terminal = await env.h.waitForTask(ref.id, ctx);
	assert.equal(starts, 1);
	assert.deepEqual(terminal.outcome, {
		status: "failed",
		failure: { reason: "interrupted", detail: "host status failed: Error: host unavailable" },
	});
});

test("job abort sends TERM, waits the fixed five-second grace, then sends KILL", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(10_000);
	const kills: Array<{ signal: "SIGTERM" | "SIGKILL"; at: number }> = [];
	let resolveStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		resolveStarted = resolve;
	});
	let resolveTerm!: () => void;
	const term = new Promise<void>((resolve) => {
		resolveTerm = resolve;
	});
	const host: ProcessHost = {
		async start() {
			resolveStarted();
		},
		async status() {
			return { status: "running", stdout: "", stderr: "", droppedStdout: 0, droppedStderr: 0 };
		},
		async kill(_key, signal) {
			kills.push({ signal, at: Date.now() });
			if (signal === "SIGTERM") resolveTerm();
		},
	};
	const env = await open({ processHost: host });
	onTestFinished(async () => {
		vi.useRealTimers();
		await env.close();
	});
	const ref = await env.root.commit(
		(tx) =>
			tx.createTask(
				kinds.job,
				{ command: "x", args: [], cwd: "/", notify: false, rerun: false },
				{ conversationId: 1, background: true },
			),
		ctx,
	);
	await started;
	await Promise.resolve();
	await env.h.abortTask(ref.id, ctx);
	await term;
	assert.deepEqual(kills, [{ signal: "SIGTERM", at: 10_000 }]);
	await vi.advanceTimersByTimeAsync(4_999);
	assert.equal(kills.length, 1);
	await vi.advanceTimersByTimeAsync(1);
	const terminal = await env.h.waitForTask(ref.id, ctx);
	assert.deepEqual(kills, [
		{ signal: "SIGTERM", at: 10_000 },
		{ signal: "SIGKILL", at: 15_000 },
	]);
	assert.deepEqual(terminal.outcome, { status: "aborted", result: { killed: true } });
});

test("suspend unwinds active invocations without terminalizing them and reopen recovers durable work", async () => {
	const gate = new Gate();
	let env = await open({ backend: "jsonl", tools: [tool("recoverable", { replay: "safe", gate })] });
	onTestFinished(() => env.close());
	const input = await env.root.send({ content: "tool:recoverable" }, ctx);
	const running = await untilPhase(env, "pi.tool", "started");
	await gate.arrivals(1);
	const lifecycle = env.h as unknown as { suspend(context: typeof ctx): Promise<void> };
	await lifecycle.suspend(ctx);

	const replacement = tool("recoverable", { replay: "safe" });
	env = await open({ dir: env.dir, backend: "jsonl", tools: [replacement] });
	await env.root.waitForIdle(ctx);
	assert.equal(replacement.calls, 1);
	assert.equal((await env.h.getTask(running.id, ctx))?.outcome?.status, "completed");
	assert.equal((await env.input(input.id))?.status, "done");
});

test("hold provides a quiescent reload cut: commits continue, dispatch waits, and re-register runs pending records with new code", async () => {
	const ran: string[] = [];
	const makeKind = (label: string) =>
		defineTask<null, { phase: "done" }, string, null, null>({
			name: "spec.held-kind",
			async initial() {
				ran.push(label);
				return { next: { phase: "done" } };
			},
			phases: {
				async done() {
					return { done: () => ({ status: "completed", result: label }) };
				},
			},
			async abort() {
				return () => null;
			},
		});
	const env = await open({});
	onTestFinished(() => env.close());
	const lifecycle = env.h as unknown as {
		quiescent(): boolean;
		hold(): () => void;
	};
	assert.equal(lifecycle.quiescent(), true);
	const release = lifecycle.hold();
	const old = makeKind("old");
	const unregister = env.h.registerTaskKind(old);
	const ref = await env.root.commit((tx) => tx.createTask(old, null, { conversationId: 1, background: true }), ctx);
	await env.root.write({ kind: "commit.while.held" }, ctx);
	assert.equal((await env.h.getTask(ref.id, ctx))?.status, "pending");
	assert.deepEqual(ran, []);
	unregister();
	const replacement = makeKind("replacement");
	env.h.registerTaskKind(replacement);
	release();
	const terminal = await env.h.waitForTask(ref.id, ctx);
	assert.deepEqual(terminal.outcome, { status: "completed", result: "replacement" });
	assert.deepEqual(ran, ["replacement"]);
	assert.equal(lifecycle.quiescent(), true);
});

test("quiescent is false for sleeping jobs and waiting hooks, not merely for actively executing JavaScript", async () => {
	const env = await open({
		processHost: {
			async start() {},
			async status() {
				return { status: "running", stdout: "", stderr: "", droppedStdout: 0, droppedStderr: 0 };
			},
			async kill() {},
		},
	});
	onTestFinished(() => env.close());
	const lifecycle = env.h as unknown as { quiescent(): boolean };
	const ref = await env.root.commit(
		(tx) =>
			tx.createTask(
				kinds.job,
				{ command: "x", args: [], cwd: "/", notify: false, rerun: false },
				{ conversationId: 1, background: true },
			),
		ctx,
	);
	await untilPhase(env, "pi.job", "running");
	assert.equal(lifecycle.quiescent(), false);
	await env.h.abortTask(ref.id, ctx);
});
