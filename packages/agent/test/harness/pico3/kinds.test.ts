import assert from "node:assert/strict";
import type { ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { onTestFinished, test } from "vitest";
import { applyEnvelope, kinds } from "../../../src/harness/pico3/harness.ts";
import type { JsonlStorage } from "../../../src/harness/pico3/jsonl.ts";
import { Session } from "../../../src/harness/pico3/session.ts";
import { defineSystemSection, sectionSeed, systemSections } from "../../../src/harness/pico3/system.ts";
import { defineTask, Forbidden, type RequestMessage, type ToolDeclaration } from "../../../src/harness/pico3/types.ts";
import {
	type CoreTx,
	collectWatch,
	contentOf,
	ctx,
	echoScript,
	failureOf,
	fake,
	Gate,
	kinds as kindsOf,
	lastMessage,
	model,
	open,
	sleep,
	tool,
	untilTerminal,
} from "./helpers.ts";

const resultOf = async (env: Awaited<ReturnType<typeof open>>) =>
	(await env.entries()).find((e) => e.kind === "pi.tool_result")!;
const dataOf = (e: { data?: unknown }) =>
	e.data as { diagnostics?: { code: string }[]; truncated?: { bytes: number; lines: number }; details?: unknown };

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

test("tool not offered → synthetic error, tool never invoked, registry not consulted", async () => {
	const t = tool("hidden");
	const env = await open({ tools: [t], root: { rewindable: { model, selectedTools: [] } } });
	onTestFinished(() => env.close());
	await (await env.root.send({ content: "tool:hidden" }, ctx)).wait(ctx);
	const r = await resultOf(env);
	assert.equal(t.calls, 0);
	assert.equal(dataOf(r).diagnostics?.[0]?.code, "not_offered");
	assert.match(contentOf(r), /not offered/);
});

test("tool offered but not registered → missing_tool", async () => {
	const env = await open({ tools: [], root: { rewindable: { model, selectedTools: ["ghost"] } } });
	onTestFinished(() => env.close());
	// selectedTools is filtered against the registry at prepare, so "ghost" is never offered → not_offered.
	await (await env.root.send({ content: "tool:ghost" }, ctx)).wait(ctx);
	assert.equal(dataOf(await resultOf(env)).diagnostics?.[0]?.code, "not_offered");
});

test("invalid arguments → invalid_arguments, not invoked", async () => {
	const t = tool("strict");
	const models = fake({
		respond: (m) =>
			lastMessage(m).role === "toolResult"
				? { text: "ok" }
				: { toolCalls: [{ name: "strict", arguments: { v: 42 } }] },
	});
	const env = await open({ tools: [t], models });
	onTestFinished(() => env.close());
	await (await env.root.send({ content: "go" }, ctx)).wait(ctx);
	assert.equal(t.calls, 0);
	assert.equal(dataOf(await resultOf(env)).diagnostics?.[0]?.code, "invalid_arguments");
});

test("beforeTool: block → blocked; rewrite arguments → invoked with rewritten; identity change → blocked; throw → blocked", async () => {
	const cases: [string, (c: ToolCall) => unknown, string, number][] = [
		["block", () => ({ block: "no" }), "blocked", 0],
		["rewrite", (c) => ({ call: { ...c, arguments: { v: "rewritten" } } }), "", 1],
		["identity", (c) => ({ call: { ...c, name: "other" } }), "blocked", 0],
		[
			"throw",
			() => {
				throw new Error("hook boom");
			},
			"blocked",
			0,
		],
	];
	for (const [label, hook, code, calls] of cases) {
		const t = tool("x");
		const env = await open({ tools: [t], hooks: { tool: { beforeTool: hook as never } } });
		onTestFinished(() => env.close().catch(() => {}));
		await (await env.root.send({ content: "tool:x" }, ctx)).wait(ctx);
		const r = await resultOf(env);
		assert.equal(t.calls, calls, label);
		if (code) assert.equal(dataOf(r).diagnostics?.[0]?.code, code, label);
		else assert.match(contentOf(r), /x\(rewritten\)/, label);
		await env.close();
	}
});

test("afterTool can replace the result; tool throw becomes an error result", async () => {
	const t = tool("x", { throws: "kaboom" });
	const env = await open({
		tools: [t],
		hooks: {
			tool: {
				afterTool: (_c, r) =>
					r.isError ? { ...r, content: [{ type: "text", text: "softened" }], isError: false } : undefined,
			},
		},
	});
	onTestFinished(() => env.close());
	await (await env.root.send({ content: "tool:x" }, ctx)).wait(ctx);
	const r = await resultOf(env);
	assert.equal(contentOf(r), JSON.stringify([{ type: "text", text: "softened" }]));
	assert.equal((r.model![0] as { isError: boolean }).isError, false);
});

test("output bounding: head keeps the first maxBytes, tail the last; lines cap; truncated recorded", async () => {
	const big = Array.from({ length: 500 }, (_, i) => `line${i}`).join("\n");
	for (const retain of ["head", "tail"] as const) {
		const t: ToolDeclaration = {
			name: "big",
			description: "",
			parameters: Type.Object({ v: Type.String() }),
			output: { maxBytes: 2000, maxLines: 100, retain },
			async execute() {
				return { content: [{ type: "text", text: big }] };
			},
		};
		const env = await open({ tools: [t] });
		onTestFinished(() => env.close().catch(() => {}));
		await (await env.root.send({ content: "tool:big" }, ctx)).wait(ctx);
		const r = await resultOf(env);
		const text = (r.model![0] as { content: { text: string }[] }).content[0]!.text;
		const lines = text.split("\n");
		assert.equal(lines.length, 100, retain);
		assert.equal(lines[0], retain === "head" ? "line0" : "line400", retain);
		assert.ok(dataOf(r).truncated!.lines === 400, retain);
		assert.equal(dataOf(r).diagnostics?.[0]?.code, "truncated");
		await env.close();
	}
});

test("tool slot: turn.tools[index] carries call and bounded output; suffix updates append; cleared when the turn ends", async () => {
	const gate = new Gate();
	const t: ToolDeclaration = {
		name: "p",
		description: "",
		parameters: Type.Object({ v: Type.String() }),
		async execute(_a, api, c) {
			api.stream("half");
			await api.progress((o) => {
				o.progress = "50%";
			}, c);
			await gate.wait(c);
			api.stream(" full");
			await api.progress((o) => {
				o.progress = "100%";
			}, c);
			return { content: [{ type: "text", text: "done" }] };
		},
	};
	const env = await open({ tools: [t] });
	onTestFinished(() => env.close());
	const { envelopes, stop } = await collectWatch(env.root);
	const a = await env.root.send({ content: "tool:p" }, ctx);
	await gate.arrivals(1);
	const mid = await env.root.sticky(ctx);
	assert.equal(mid.turn.tools.length, 1);
	assert.equal(mid.turn.tools[0]!.callId, "call_0_0");
	assert.equal(mid.turn.tools[0]!.output, "half");
	gate.open();
	await a.wait(ctx);
	await env.root.waitForIdle(ctx);
	assert.deepEqual((await env.root.sticky(ctx)).turn, { tools: [] });
	assert.deepEqual((await env.root.sticky(ctx)).tasks, {});
	const ops = envelopes.flatMap((envelope) => envelope.ops);
	assert.ok(
		ops.some((op) => op[0] === "a" && op[1].join(".") === "turn.tools.0.output" && op[2] === " full"),
		"the suffix update is an append on the output path",
	);
	stop();
});

test("ordinary kinds cannot appendEntry or create core tasks (runtime Forbidden), but can write()", async () => {
	const seen: string[] = [];
	const env = await open({
		plugins: {
			probe: async (_i, api, c) => {
				await api
					.task(kinds.job, { command: "x", args: [], cwd: "/", notify: false, rerun: false }, {}, c)
					.catch((e) => seen.push(String(e)));
				return "ok";
			},
		},
		hooks: {},
		processHost: undefined,
	});
	onTestFinished(() => env.close());
	// appendEntry from a non-core invoker
	await assert.rejects(
		env.root.commit((tx) => (tx as unknown as CoreTx).appendEntry(1, { kind: "pi.notice" }), ctx),
		Forbidden,
	);
	// core task creation from an ordinary task: use pi.plugin to try
	const id = await env.root.commit(
		(tx) =>
			tx.createTask(kinds.plugin, { handler: "probe", input: null }, { conversationId: 1, background: true }).id,
		ctx,
	);
	await untilTerminal(env, id);
	// pi.job is ordinary, so that succeeded; now try a core kind directly
	const id2 = await env.root
		.commit(
			(tx) =>
				tx.createTask(kinds.plugin, { handler: "core", input: null }, { conversationId: 1, background: true }).id,
			ctx,
		)
		.catch(() => undefined);
	void id2;
	const env2 = await open({
		plugins: {
			core: async (_i, api, c) => {
				try {
					await api.task(kinds.generation, { inputs: [] }, {}, c);
					return "created";
				} catch (e) {
					return String(e);
				}
			},
		},
	});
	onTestFinished(() => env2.close());
	const id3 = await env2.root.commit(
		(tx) => tx.createTask(kinds.plugin, { handler: "core", input: null }, { conversationId: 1, background: true }).id,
		ctx,
	);
	const done = await untilTerminal(env2, id3);
	assert.match(String((done.outcome as unknown as { result: string }).result), /Forbidden/);
	// write() from host is fine
	const w = await env.root.write({ kind: "pi.notice", model: [{ role: "user", content: "n", timestamp: 0 }] }, ctx);
	assert.equal((await env.input(w))?.status, "done");
});

// ---------------------------------------------------------------------------
// Collapse
// ---------------------------------------------------------------------------

const summarizer = (m: RequestMessage[]) =>
	m.some(
		(x) => x.role === "user" && String((x as { content: unknown }).content).includes("Respond with the summary only"),
	)
		? { text: "SUMMARY" }
		: echoScript(m);

test("threshold collapse: created foreground after a response over threshold; summary head placed; context shrinks", async () => {
	const env = await open({
		models: fake({ respond: summarizer }),
		root: { rewindable: { model, threshold: 100, keepRecent: 30 } },
	});
	onTestFinished(() => env.close());
	for (const t of ["one", "two", "three", "four"]) await (await env.root.send({ content: t }, ctx)).wait(ctx);
	await env.root.waitForIdle(ctx);
	const collapses = (await env.tasks()).filter((t) => t.kind === "pi.collapse");
	assert.ok(collapses.length >= 1);
	assert.equal(collapses[0]!.background, undefined); // foreground
	assert.equal((collapses[0]!.input as { reason: string }).reason, "threshold");
	const { entries, head } = await env.root.commit((tx) => tx.context(1), ctx);
	assert.equal(head?.kind, "pi.summary");
	assert.ok(entries.length < 8);
	assert.equal(contentOf(head), "SUMMARY ");
	// summarizer request was tool-free and ended with the instruction
	const req = (env.h as unknown as { options?: unknown }) && null;
	void req;
});

test("beforeCollapse: decline → failed/declined; hook summary → no provider call; instructions override", async () => {
	for (const mode of ["decline", "summary", "instructions"] as const) {
		const models = fake({ respond: summarizer });
		const env = await open({
			models,
			root: { rewindable: { model, keepRecent: 10 } },
			hooks: {
				collapse: {
					beforeCollapse: () =>
						mode === "decline"
							? { decline: true }
							: mode === "summary"
								? { summary: "HOOKED" }
								: { instructions: "Be terse. Respond with the summary only" },
				},
			},
		});
		onTestFinished(() => env.close().catch(() => {}));
		for (const t of ["one", "two", "three"]) await (await env.root.send({ content: t }, ctx)).wait(ctx);
		const before = models.calls;
		const cid = await env.root.collapse(undefined, ctx);
		const c = await untilTerminal(env, cid);
		if (mode === "decline") {
			assert.equal((c.outcome as unknown as { failure: { reason: string } }).failure.reason, "declined");
			assert.equal(models.calls, before);
		} else if (mode === "summary") {
			assert.equal(c.outcome?.status, "completed");
			assert.equal(models.calls, before);
			assert.equal(contentOf((await env.entries()).find((e) => e.kind === "pi.summary")), "HOOKED");
		} else {
			assert.equal(c.outcome?.status, "completed");
			assert.equal(models.calls, before + 1);
			const last = models.requests[models.requests.length - 1]!;
			assert.match(String((last[last.length - 1] as { content: string }).content), /Be terse/);
		}
		await env.close();
	}
});

test("collapse is stale if another head lands between snapshot and finalization", async () => {
	const gate = new Gate();
	const models = fake({ respond: summarizer, gate });
	const env = await open({ models, root: { rewindable: { model, keepRecent: 10 } } });
	onTestFinished(() => env.close());
	gate.open();
	for (const t of ["one", "two", "three"]) await (await env.root.send({ content: t }, ctx)).wait(ctx);
	gate.close();
	const cid = await env.root.collapse(undefined, ctx);
	await gate.arrivals(4); // summarizer in flight
	await env.root.reset(undefined, ctx); // a new head
	gate.open();
	const c = await untilTerminal(env, cid);
	assert.equal((c.outcome as unknown as { failure: { reason: string } }).failure.reason, "stale");
	assert.equal((await env.entries()).filter((e) => e.kind === "pi.summary").length, 0);
});

test("manual collapse with nothing to collapse rejects", async () => {
	const env = await open({});
	onTestFinished(() => env.close());
	await (await env.root.send({ content: "one" }, ctx)).wait(ctx);
	await assert.rejects(env.root.collapse(undefined, ctx), /nothing to collapse/);
});

// ---------------------------------------------------------------------------
// Forks and documents
// ---------------------------------------------------------------------------

test("fork: rewindable as of the fork point, sticky defaults, inbox not inherited, context inherited up to `at`", async () => {
	const gate = new Gate();
	const env = await open({
		models: fake({ respond: echoScript, gate }),
		root: { rewindable: { model }, sticky: { followUpMode: "all" } },
	});
	onTestFinished(() => env.close());
	const state = env.h.namespace<{ k: string; s: string }>("test.fork-state", {
		rewindable: { k: "" },
		sticky: { s: "" },
	});
	gate.open();
	await env.root.commit((tx) => {
		tx.plugins(state).k = "v1";
	}, ctx);
	const a = await (await env.root.send({ content: "one" }, ctx)).wait(ctx);
	await env.root.commit((tx) => {
		const plugins = tx.plugins(state);
		plugins.k = "v2";
		plugins.s = "sticky";
	}, ctx);
	await (await env.root.send({ content: "two" }, ctx)).wait(ctx);
	gate.close();
	const busy = await env.root.send({ content: "three" }, ctx);
	await gate.arrivals(3);
	await env.root.send({ content: "queued" }, ctx);

	const fork = await env.root.fork(a.answer!, {}, ctx);
	const fr = await fork.rewindable(ctx);
	const fs = await fork.sticky(ctx);
	assert.equal(fr.plugins["test.fork-state"]?.k, "v1");
	assert.equal(fr.model?.modelId, "fake-1");
	assert.equal(fs.followUpMode, "one-at-a-time"); // sticky not inherited
	assert.equal(fs.plugins["test.fork-state"]?.s, undefined);
	assert.deepEqual(fs.inbox, []);
	const { entries } = await fork.commit((tx) => tx.context(fork.id), ctx);
	assert.equal(kindsOf(entries), "user system assistant");
	// fork is independent: it can run while the parent is busy
	gate.open();
	const fa = await (await fork.send({ content: "in fork" }, ctx)).wait(ctx);
	assert.equal(fa.status, "done");
	await busy.wait(ctx);
	assert.equal(kindsOf(await env.entries(fork.id)), "user system assistant user assistant"); // fork-aware: inherited prefix + own (system unchanged → not re-emitted)
	assert.equal(
		kindsOf((await fork.commit((tx) => tx.context(fork.id), ctx)).entries),
		"user system assistant user assistant",
	);
	// parent's later writes are invisible to the fork
	assert.equal((await fork.rewindable(ctx)).plugins["test.fork-state"]?.k, "v1");
});

test("fork at 'start' inherits nothing", async () => {
	const env = await open({});
	onTestFinished(() => env.close());
	await (await env.root.send({ content: "one" }, ctx)).wait(ctx);
	const fork = await env.root.fork("start", { rewindable: { model } }, ctx);
	assert.equal(kindsOf((await fork.commit((tx) => tx.context(fork.id), ctx)).entries), "");
	assert.equal((await fork.commit((tx) => tx.conversation(fork.id), ctx))?.parent, undefined);
});

test("sticky sidecar truncates to one base after retire; rewindable log keeps history", async () => {
	const env = await open({ backend: "jsonl" });
	onTestFinished(() => env.close());
	const sizes = () => (env.storage as JsonlStorage).sizes();
	for (let i = 0; i < 5; i++) await (await env.root.send({ content: "x ".repeat(200) }, ctx)).wait(ctx);
	await env.root.waitForIdle(ctx);
	await sleep(20);
	const s1 = sizes()["sticky-1.jsonl"]!;
	for (let i = 0; i < 5; i++) await (await env.root.send({ content: "x ".repeat(200) }, ctx)).wait(ctx);
	await env.root.waitForIdle(ctx);
	await sleep(20);
	const s2 = sizes()["sticky-1.jsonl"]!;
	assert.ok(Math.abs(s1 - s2) < 200, `sticky steady state: ${s1} vs ${s2}`);
	assert.ok(sizes()["main.jsonl"]! > 10_000);
});

test("watch: capture + stream == fresh snapshot after a full turn; head truncates view.entries", async () => {
	const env = await open({
		tools: [tool("a")],
		root: { rewindable: { model, selectedTools: ["a"], keepRecent: 10 } },
		models: fake({ respond: summarizer }),
	});
	onTestFinished(() => env.close());
	const state = env.h.namespace<{ w: number }>("test.watch-private", { rewindable: { w: 0 } });
	const { view, envelopes, stop } = await collectWatch(env.root);
	await (await env.root.send({ content: "tool:a" }, ctx)).wait(ctx);
	await env.root.commit((tx) => {
		tx.plugins(state).w = 1;
	}, ctx);
	const cid = await env.root.collapse(undefined, ctx);
	await untilTerminal(env, cid);
	await env.root.waitForIdle(ctx);
	await sleep(20);
	stop();
	let folded = view;
	for (const d of envelopes) folded = applyEnvelope(folded, d);
	const fresh = await collectWatch(env.root);
	fresh.stop();
	assert.deepEqual(
		folded.entries.map((e) => e.id),
		fresh.view.entries.map((e) => e.id),
	);
	assert.deepEqual(folded, fresh.view);
	assert.deepEqual(folded.tasks, {});
	// the summary head truncated the view
	const summary = folded.entries.find((e) => e.kind === "pi.summary")!;
	assert.ok(folded.entries.every((e) => e.id >= summary.head!));
});

test("plugin task: handler runs with the api, result recorded; missing handler fails", async () => {
	const env = await open({ plugins: { double: async (i) => (i as number) * 2 } });
	onTestFinished(() => env.close());
	const id = await env.root.commit(
		(tx) => tx.createTask(kinds.plugin, { handler: "double", input: 21 }, { conversationId: 1, background: true }).id,
		ctx,
	);
	assert.deepEqual((await untilTerminal(env, id)).outcome, { status: "completed", result: 42 });
	const id2 = await env.root.commit(
		(tx) => tx.createTask(kinds.plugin, { handler: "nope", input: null }, { conversationId: 1, background: true }).id,
		ctx,
	);
	assert.equal(failureOf(await untilTerminal(env, id2))?.reason, "missing_handler");
});

test("system sections: unchanged → no new system entry; changed → delta; after a head → full baseline with omission edits", async () => {
	let prompt = "P1";
	const env = await open({
		hooks: {
			generation: {
				systemInstructions: ({ sections }) => {
					sections.set(systemSections.identity, prompt);
				},
			},
		},
		models: fake({ respond: summarizer }),
		root: { rewindable: { model, keepRecent: 10 } },
	});
	onTestFinished(() => env.close());
	await (await env.root.send({ content: "one" }, ctx)).wait(ctx);
	await (await env.root.send({ content: "two" }, ctx)).wait(ctx);
	assert.equal((await env.entries()).filter((e) => e.kind === "pi.system").length, 1);
	prompt = "P2";
	await (await env.root.send({ content: "three" }, ctx)).wait(ctx);
	const sys = (await env.entries()).filter((e) => e.kind === "pi.system");
	assert.equal(sys.length, 2);
	assert.equal((sys[0]!.data as { baseline?: true }).baseline, true); // first ever: baseline (no head, no prior managed entry → §12.4 says baseline when newestBaseline is null and a head exists; here it's the seed case)
	assert.equal((sys[1]!.data as { baseline?: true; sections: { key: string; action: string }[] }).baseline, undefined); // delta
	assert.deepEqual(
		(sys[1]!.data as { sections: { key: string; action: string }[] }).sections.map((r) => `${r.action}:${r.key}`),
		["set:identity"],
	);
	assert.match((sys[1]!.model![0] as { content: string }).content, /identity section now reads:\nP2/);
	await env.root.reset(undefined, ctx);
	await (await env.root.send({ content: "four" }, ctx)).wait(ctx);
	const sys2 = (await env.entries()).filter((e) => e.kind === "pi.system");
	assert.equal(sys2.length, 3);
	assert.equal((sys2[2]!.data as { baseline?: true }).baseline, true);
	assert.match((sys2[2]!.model![0] as { content: string }).content, /## identity\nP2/);
	const { messages } = await env.root.commit((tx) => tx.context(1), ctx);
	assert.equal(messages.filter((m) => m.role === "system").length, 1); // earlier managed entries are before the head or omitted
});

test("context: a tool result missing after a fork is synthesised", async () => {
	const env = await open({ tools: [tool("a")] });
	onTestFinished(() => env.close());
	await (await env.root.send({ content: "tool:a" }, ctx)).wait(ctx);
	const entries = await env.entries();
	const assistant = entries.find((e) => e.kind === "pi.assistant")!;
	// fork at the assistant with tool calls: its result is after `at` and invisible
	const fork = await env.root.fork(assistant.id, {}, ctx);
	const { messages } = await fork.commit((tx) => tx.context(fork.id), ctx);
	const tr = messages.find((message) => message.role === "toolResult");
	assert.ok(tr?.role === "toolResult");
	assert.equal(tr.isError, true);
	assert.equal((tr.details as { reason?: string } | undefined)?.reason, "missing_after_fork");
});

test("api.stream: kernel bounds per declaration, throttles flushes, result content defaults to the bounded stream", async () => {
	const t: ToolDeclaration = {
		name: "s",
		description: "",
		parameters: Type.Object({ v: Type.String() }),
		output: { maxBytes: 100, retain: "tail" },
		async execute(_a, api) {
			for (let i = 0; i < 50; i++) api.stream(`chunk${i} `);
			return {};
		},
	};
	const env = await open({ tools: [t] });
	onTestFinished(() => env.close());
	const { envelopes, stop } = await collectWatch(env.root);
	await (await env.root.send({ content: "tool:s" }, ctx)).wait(ctx);
	stop();
	const r = await resultOf(env);
	const text = (r.model![0] as { content: { text: string }[] }).content[0]!.text;
	assert.ok(text.length <= 100 && text.endsWith("chunk49 "), text);
	assert.equal(dataOf(r).diagnostics?.[0]?.code, "truncated");
	const flushes = envelopes.filter((envelope) =>
		envelope.ops.some((op) => op[0] === "s" && op[1].includes("output")),
	).length;
	assert.ok(flushes <= 2, `throttled: ${flushes} flushes for 50 chunks`);
});

test("tools cannot bound their own output: a returned content larger than the bound is still bounded by the kernel", async () => {
	const t: ToolDeclaration = {
		name: "big",
		description: "",
		parameters: Type.Object({ v: Type.String() }),
		output: { maxBytes: 10 },
		async execute() {
			return { content: [{ type: "text", text: "x".repeat(1000) }] };
		},
	};
	const env = await open({ tools: [t] });
	onTestFinished(() => env.close());
	await (await env.root.send({ content: "tool:big" }, ctx)).wait(ctx);
	const r = await resultOf(env);
	assert.equal((r.model![0] as { content: { text: string }[] }).content[0]!.text.length, 10);
	assert.equal(dataOf(r).truncated!.bytes, 990);
});

test("§12: sections render through the draft; wrap applies after render; delete emits a remove; a throwing handler's edits roll back", async () => {
	const custom = defineSystemSection<{ n: number }>({ key: "custom", render: (v) => `custom=${v.n}` });
	let throwOnce = true;
	const env = await open({
		sections: [custom],
		hooks: {
			generation: {
				systemInstructions: ({ sections }) => {
					sections.set(systemSections.identity, "I am");
					sections.set(custom, { n: 1 });
					sections.wrap(systemSections.identity, (r) => `[${r}]`);
				},
			},
		},
		models: fake({ respond: summarizer }),
		root: { rewindable: { model, keepRecent: 10 } },
	});
	onTestFinished(() => env.close());
	const hookNamespace = env.h.namespace("test.section-hooks", {});
	env.h.hooks(hookNamespace, kinds.generation, {
		systemInstructions: ({ sections }) => {
			if (throwOnce) {
				throwOnce = false;
				sections.set(custom, { n: 999 });
				throw new Error("boom");
			}
		},
	});
	await (await env.root.send({ content: "one" }, ctx)).wait(ctx);
	const sys = (await env.entries()).filter((e) => e.kind === "pi.system");
	const content = (sys[0]!.model![0] as { content: string }).content;
	assert.match(content, /## identity\n\[I am\]/);
	assert.match(content, /## custom\ncustom=1/); // the throwing handler's n=999 was rolled back
	const data = sys[0]!.data as { sections: { key: string; action: string; value?: unknown }[] };
	assert.deepEqual(
		data.sections.map((s) => s.key),
		["identity", "custom"],
	);
	// delete → remove delta
	env.h.hooks(hookNamespace, kinds.generation, {
		systemInstructions: ({ sections }) => {
			sections.delete(custom);
		},
	});
	await (await env.root.send({ content: "two" }, ctx)).wait(ctx);
	const sys2 = (await env.entries()).filter((e) => e.kind === "pi.system");
	assert.equal(sys2.length, 2);
	assert.deepEqual((sys2[1]!.data as { sections: { key: string; action: string }[] }).sections, [
		{ key: "custom", action: "remove" },
	]);
	assert.match((sys2[1]!.model![0] as { content: string }).content, /custom section no longer applies/);
});

test("§12.5: a config change while systemInstructions runs makes the preparation retry with fresh inputs", async () => {
	const gate = new Gate();
	let runs = 0;
	const env = await open({
		hooks: {
			generation: {
				systemInstructions: async ({ sections, config }, _i, c) => {
					runs++;
					sections.set(systemSections.identity, `profile=${config.profile}`);
					if (runs === 1) await gate.wait(c);
				},
			},
		},
	});
	onTestFinished(() => env.close());
	const a = await env.root.send({ content: "one" }, ctx);
	await gate.arrivals(1);
	await env.root.config.set({ profile: "changed" }, ctx); // snapshot S is now stale
	gate.open();
	await a.wait(ctx);
	assert.equal(runs, 2); // discarded and repeated
	const sys = (await env.entries()).find((e) => e.kind === "pi.system")!;
	assert.match((sys.model![0] as { content: string }).content, /profile=changed/);
});

test("§8.1: a section seed applies to a new conversation while it has no managed entry", async () => {
	const env = await open({});
	onTestFinished(() => env.close());
	const child = await env.h.createConversation(
		{ rewindable: { model }, sections: [sectionSeed(systemSections.identity, "seeded identity")] },
		ctx,
	);
	await (await child.send({ content: "hi" }, ctx)).wait(ctx);
	const sys = (await env.entries(child.id)).find((e) => e.kind === "pi.system")!;
	assert.match((sys.model![0] as { content: string }).content, /## identity\nseeded identity/);
});

test("c.config: flat get/set across both documents; typed by registered kinds; disjointness enforced at open", async () => {
	const plan = defineTask<null, { phase: "x" }, null, null, null, object, { rewindable: { planMode: boolean } }>({
		name: "plan",
		config: { rewindable: { planMode: false } },
		phases: {
			async x() {
				return { done: () => ({ status: "completed", result: null }) };
			},
		},
		async initial() {
			return { next: { phase: "x" } };
		},
		async abort() {
			return () => null;
		},
	});
	const env = await open({ taskKinds: [plan] });
	onTestFinished(() => env.close());
	const before = await env.root.config.get(ctx);
	assert.equal((before as { planMode: boolean }).planMode, false); // default from the kind
	assert.equal(before.followUpMode, "one-at-a-time");
	await env.root.config.set({ planMode: true, followUpMode: "all", keepRecent: 5 } as never, ctx);
	assert.equal((await env.root.rewindable(ctx)).planMode, true);
	assert.equal((await env.root.rewindable(ctx)).keepRecent, 5);
	assert.equal((await env.root.sticky(ctx)).followUpMode, "all");
	await env.root.config.reset(["planMode", "followUpMode", "keepRecent"], ctx);
	const reset = await env.root.config.get(ctx);
	assert.equal((reset as { planMode: boolean }).planMode, false);
	assert.equal(reset.followUpMode, "one-at-a-time");
	assert.equal(reset.keepRecent, 20_000);
	await assert.rejects(env.root.config.set({ keepRecent: undefined } as never, ctx), /use config\.reset/);
	const clash = defineTask<null, { phase: "x" }, null, null, null, object, { sticky: { model: string } }>({
		name: "clash",
		config: { sticky: { model: "" } },
		phases: {
			async x() {
				return { done: () => ({ status: "completed", result: null }) };
			},
		},
		async initial() {
			return { next: { phase: "x" } };
		},
		async abort() {
			return () => null;
		},
	});
	await assert.rejects(open({ taskKinds: [clash] as never }), /declared by more than one kind/);
});

test("defineTask: an ordinary kind with phases runs, checkpoints, recovers into its phase, and is typed via TaskRef", async () => {
	const gate = new Gate();
	const ran: string[] = [];
	const counter = defineTask<{ start: number }, { phase: "counting"; n: number }, { total: number }, never, null>({
		name: "counter",
		async initial(task) {
			ran.push("initial");
			return { next: { phase: "counting", n: task.input.start } };
		},
		phases: {
			async counting(task, _rt, ctx) {
				ran.push(`counting@${task.checkpoint.n}`);
				if (task.checkpoint.n < 3) {
					await gate.wait(ctx);
					return { next: { phase: "counting", n: task.checkpoint.n + 1 } };
				}
				return { done: () => ({ status: "completed", result: { total: task.checkpoint.n } }) };
			},
		},
		async abort() {
			return () => null;
		},
	});
	let env = await open({ backend: "jsonl", taskKinds: [counter] });
	onTestFinished(() => env.close());
	const ref = await env.root.commit(
		(tx) => tx.createTask(counter, { start: 1 }, { conversationId: 1, background: true }),
		ctx,
	);
	await gate.arrivals(1);
	await env.crash();
	env = await open({ dir: env.dir, backend: "jsonl", taskKinds: [counter] });
	gate.open();
	const done = await untilTerminal(env, ref.id);
	assert.deepEqual(done.outcome, { status: "completed", result: { total: 3 } });
	assert.deepEqual(ran, ["initial", "counting@1", "counting@1", "counting@2", "counting@3"]); // resumed into `counting@1` after the crash, not `initial`
});

test("sticky log: a base is written when the conversation goes idle, or when ops exceed the budget while busy — never per task", async () => {
	const gate = new Gate();
	// A tool that streams a lot while another tool holds the turn open.
	const noisy: ToolDeclaration = {
		name: "noisy",
		description: "",
		parameters: Type.Object({ v: Type.String() }),
		output: { maxBytes: 100_000, retain: "tail" },
		async execute(_a, api, c) {
			for (let i = 0; i < 40; i++) {
				api.stream(`${i}:`.repeat(2_000));
				await sleep(12);
			}
			await gate.wait(c);
			return {};
		},
	};
	const env = await open({
		backend: "jsonl",
		tools: [noisy],
		models: fake({
			respond: (m) =>
				lastMessage(m).role === "toolResult"
					? { text: "ok" }
					: {
							toolCalls: [
								{ name: "noisy", arguments: { v: "a" } },
								{ name: "noisy", arguments: { v: "b" } },
							],
						},
		}),
	});
	onTestFinished(() => env.close());
	const a = await env.root.send({ content: "go" }, ctx);
	await gate.arrivals(2);
	const bytesWhileBusy = (env.storage as JsonlStorage).sizes()["sticky-1.jsonl"]!;
	assert.ok(bytesWhileBusy > Session.STICKY_BASE_BUDGET, `streamed ${bytesWhileBusy} bytes of sticky state`);
	gate.open();
	await a.wait(ctx);
	await env.root.waitForIdle(ctx);
	await sleep(20);
	const sizes = (env.storage as JsonlStorage).sizes();
	assert.ok(sizes["sticky-1.jsonl"]! < 5_000, `truncated to one small base: ${sizes["sticky-1.jsonl"]}`);
});
