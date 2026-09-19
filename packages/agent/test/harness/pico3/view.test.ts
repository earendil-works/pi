import assert from "node:assert/strict";
import { withAbortSignal } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { onTestFinished, test } from "vitest";
import { applyEnvelope, type ConversationView, kinds } from "../../../src/harness/pico3/harness.ts";
import type { ToolDeclaration } from "../../../src/harness/pico3/types.ts";
import {
	collectWatch,
	contentOf,
	ctx,
	echoScript,
	fake,
	fakeHost,
	Gate,
	open,
	sleep,
	untilTerminal,
} from "./helpers.ts";

/** What a UI reads from the view. This is the whole rendering model. */
function uiModel(v: ConversationView) {
	const turn = v.turn;
	return {
		transcript: v.entries.map((entry) => entry.kind.replace("pi.", "")),
		streaming: turn?.message ? (turn.message.content[0] as { text?: string } | undefined)?.text : undefined,
		runningTools: (turn?.tools ?? []).map((tool) => ({
			name: tool.name,
			output: tool.output,
			continuedBy: tool.continuedBy,
		})),
		background: Object.entries(v.tasks)
			.filter(([, task]) => task.background)
			.map(([id, task]) => ({ id: Number(id), kind: task.kind, slot: task.status })),
		working: turn !== undefined,
	};
}
const turnOf = (v: ConversationView) => v;

test("turn view: streaming message → tools[] atomically with the assistant entry → cleared at final answer", async () => {
	const gate = new Gate();
	const toolGate = new Gate();
	const t: ToolDeclaration = {
		name: "x",
		description: "",
		parameters: Type.Object({ v: Type.String() }),
		async execute(_a, api, c) {
			api.stream("partial ");
			await toolGate.wait(c);
			api.stream("done");
			return {};
		},
	};
	const env = await open({ tools: [t], models: fake({ respond: echoScript, gate, tokenDelayMs: 2 }) });
	onTestFinished(() => env.close());
	const { view, envelopes, stop } = await collectWatch(env.root);
	let v = view;
	const fold = () => {
		for (const d of envelopes.splice(0)) v = applyEnvelope(v, d);
		return uiModel(turnOf(v));
	};

	const a = await env.root.send({ content: "tool:x" }, ctx);
	await gate.arrivals(1);
	gate.open();
	await sleep(30); // a few frames of "Let me..." — echoScript's tool response has no text, so streaming shows toolcall only
	await toolGate.arrivals(1);
	const mid = fold();
	assert.deepEqual(mid.transcript, ["user", "system", "assistant"]); // assistant entry landed…
	assert.deepEqual(mid.runningTools, [{ name: "x", output: "partial ", continuedBy: undefined }]); // …with its tools, in the same envelope
	assert.equal(mid.streaming, undefined);
	assert.equal(mid.working, true);
	// the envelope that appended the assistant entry also created turn.tools: no frame where one exists without the other
	toolGate.open();
	await a.wait(ctx);
	await env.root.waitForIdle(ctx);
	const end = fold();
	assert.deepEqual(end.transcript, ["user", "system", "assistant", "tool_result", "assistant"]);
	assert.deepEqual(end.runningTools, []);
	assert.equal(end.streaming, undefined);
	assert.equal(end.working, false);
	stop();
});

test("streaming assistant text is visible in turn.message before the entry lands, and the fold equals a fresh snapshot", async () => {
	const gate = new Gate();
	const words = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
	const env = await open({ models: fake({ respond: () => ({ text: words }), gate, tokenDelayMs: 10 }) });
	onTestFinished(() => env.close());
	const { view, envelopes, stop } = await collectWatch(env.root);
	let v = view;
	const fold = () => {
		for (const d of envelopes.splice(0)) v = applyEnvelope(v, d);
		return uiModel(turnOf(v));
	};
	const a = await env.root.send({ content: "hi" }, ctx);
	await gate.arrivals(1);
	gate.open();
	await sleep(250);
	const mid = fold();
	assert.ok(
		mid.streaming !== undefined && mid.streaming.length > 0 && mid.streaming.length < words.length,
		`partial: ${JSON.stringify(mid.streaming)}`,
	);
	assert.deepEqual(mid.transcript, ["user", "system"]);
	await a.wait(ctx);
	const end = fold();
	assert.equal(end.streaming, undefined);
	assert.deepEqual(end.transcript, ["user", "system", "assistant"]);
	const fresh = await collectWatch(env.root);
	fresh.stop();
	assert.deepEqual(v, fresh.view);
	stop();
});

test("a tool backgrounds into a job: turn slot links continuedBy, the job streams into tasks[id], the turn ends, the job lives on", async () => {
	const host = fakeHost();
	const bg: ToolDeclaration = {
		name: "bg",
		description: "",
		parameters: Type.Object({ v: Type.String() }),
		async execute(_a, api, c) {
			const job = await api.task(
				kinds.job,
				{ command: "sleep", args: [], cwd: "/", notify: false, rerun: false },
				{ background: true },
				c,
			);
			await api.progress((s) => {
				s.continuedBy = job.id;
				s.progress = "backgrounded";
			}, c);
			return {
				content: [{ type: "text", text: `continues in background as task ${job.id}` }],
				details: { jobId: job.id },
			};
		},
	};
	const env = await open({ tools: [bg], processHost: host, models: fake({ respond: echoScript }) });
	onTestFinished(() => env.close());
	const { view, envelopes, stop } = await collectWatch(env.root);
	let v = view;
	const fold = () => {
		for (const d of envelopes.splice(0)) v = applyEnvelope(v, d);
		return uiModel(turnOf(v));
	};

	const a = await env.root.send({ content: "tool:bg" }, ctx);
	await a.wait(ctx);
	await env.root.waitForIdle(ctx);
	const jobId = (await env.tasks()).find((t) => t.kind === "pi.job")!.id;
	const key = `${jobId}:1`;
	// turn is over; the job is still running and visible under background with its own slot
	for (let i = 0; i < 50 && !host.procs.has(key); i++) await sleep(5);
	const m1 = fold();
	assert.deepEqual(m1.runningTools, []); // turn cleared
	assert.equal(m1.working, false);
	assert.deepEqual(
		m1.background.map((b) => b.kind),
		["pi.job"],
	);
	// the tool result entry carries the link durably (turn slot is gone, but the result says where it went)
	const tr = (await env.entries()).find((e) => e.kind === "pi.tool_result")!;
	assert.equal((tr.data as { details: { jobId: number } }).details.jobId, jobId);
	// job output streams into tasks[jobId]
	host.procs.get(key)!.status = {
		status: "running",
		stdout: "job says hi",
		stderr: "",
		droppedStdout: 0,
		droppedStderr: 0,
	};
	await sleep(150);
	const m2 = fold();
	assert.equal((m2.background[0]!.slot as { stdout: string }).stdout, "job says hi");
	host.exit(key, 0);
	await untilTerminal(env, jobId);
	await sleep(20);
	const m3 = fold();
	assert.deepEqual(m3.background, []);
	assert.deepEqual(v.tasks, {});
	stop();
});

/** Start a job; watch it under this tool until `timeoutMs`; then let it continue in the background. */
function jobTool(timeoutMs: number): ToolDeclaration {
	return {
		name: "run",
		description: "",
		parameters: Type.Object({ v: Type.String() }),
		async execute(_a, api, ctx) {
			const job = await api.task(
				kinds.job,
				{ command: "x", args: [], cwd: "/", notify: false, rerun: false },
				{ background: true },
				ctx,
			);
			await api.progress((s) => {
				s.continuedBy = job.id;
			}, ctx); // UI renders tasks[job.id] under this tool from here on
			const budget = withAbortSignal(AbortSignal.timeout(timeoutMs), ctx);
			try {
				const done = await api.waitForTask(job, budget); // the ref carries the kind: typed outcome, nothing else passed
				if (done.outcome?.status !== "completed")
					return { content: [{ type: "text", text: `job ${done.outcome?.status}` }], isError: true };
				return {
					content: [{ type: "text", text: done.outcome.result.stdout }],
					isError: done.outcome.result.exitCode !== 0,
					details: { jobId: job.id, finished: true },
				};
			} catch (error) {
				if (ctx.abortSignal?.aborted) throw error; // a real abort, not our budget
				// The model gets what the job produced so far, plus where to find the rest.
				const soFar = (await api.slot(job, ctx))?.stdout ?? "";
				return {
					content: [{ type: "text", text: `${soFar}\n\n[still running in the background as task ${job.id}]` }],
					details: { jobId: job.id, finished: false },
				};
			}
		},
	};
}

test("job under a tool: finishes within the budget → result is the job's output", async () => {
	const host = fakeHost();
	const env = await open({ tools: [jobTool(2000)], processHost: host, models: fake({ respond: echoScript }) });
	onTestFinished(() => env.close());
	const { view, envelopes, stop } = await collectWatch(env.root);
	let v = view;
	const fold = () => {
		for (const d of envelopes.splice(0)) v = applyEnvelope(v, d);
		return uiModel(turnOf(v));
	};
	const a = await env.root.send({ content: "tool:run" }, ctx);
	let key = "";
	for (let i = 0; i < 100 && !key; i++) {
		await sleep(5);
		key = [...host.procs.keys()][0] ?? "";
	}
	host.procs.get(key)!.status = {
		status: "running",
		stdout: "halfway",
		stderr: "",
		droppedStdout: 0,
		droppedStderr: 0,
	};
	await sleep(150);
	const mid = fold();
	// UI: the running tool links to the job, whose live stdout is under background
	assert.equal(mid.runningTools[0]!.continuedBy, mid.background[0]!.id);
	assert.equal((mid.background[0]!.slot as { stdout: string }).stdout, "halfway");
	host.exit(key, 0);
	await a.wait(ctx);
	await env.root.waitForIdle(ctx);
	const tr = (await env.entries()).find((e) => e.kind === "pi.tool_result")!;
	assert.equal(contentOf(tr), JSON.stringify([{ type: "text", text: `out ${key}` }]));
	assert.equal((tr.data as { details: { finished: boolean } }).details.finished, true);
	const end = fold();
	assert.deepEqual(end.background, []);
	stop();
});

test("job under a tool: budget expires → tool returns, job continues in background, turn ends", async () => {
	const host = fakeHost();
	const env = await open({ tools: [jobTool(300)], processHost: host, models: fake({ respond: echoScript }) });
	onTestFinished(() => env.close());
	const { view, envelopes, stop } = await collectWatch(env.root);
	let v = view;
	const fold = () => {
		for (const d of envelopes.splice(0)) v = applyEnvelope(v, d);
		return uiModel(turnOf(v));
	};
	const a = await env.root.send({ content: "tool:run" }, ctx);
	let key = "";
	for (let i = 0; i < 100 && !key; i++) {
		await sleep(5);
		key = [...host.procs.keys()][0] ?? "";
	}
	host.procs.get(key)!.status = {
		status: "running",
		stdout: "first 20 lines",
		stderr: "",
		droppedStdout: 0,
		droppedStderr: 0,
	};
	await a.wait(ctx);
	await env.root.waitForIdle(ctx);
	const tr = (await env.entries()).find((e) => e.kind === "pi.tool_result")!;
	assert.equal((tr.data as { details: { finished: boolean } }).details.finished, false);
	assert.match(contentOf(tr), /first 20 lines[\s\S]*still running/); // the model sees the partial output AND the note
	const m = fold();
	assert.deepEqual(m.runningTools, []); // turn over
	assert.equal(m.working, false);
	assert.equal(m.background.length, 1); // the job lives on
	const jobId = m.background[0]!.id;
	assert.equal((await env.tasks()).find((t) => t.id === jobId)!.status, "running"); // the tool's timeout did not abort it
	host.exit(`${jobId}:1`, 0);
	await untilTerminal(env, jobId);
	stop();
});
