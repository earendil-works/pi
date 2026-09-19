import assert from "node:assert/strict";
import { Type } from "typebox";
import { onTestFinished, test } from "vitest";
import { kinds } from "../../../src/harness/pico3/harness.ts";
import type { RequestMessage, ToolDeclaration } from "../../../src/harness/pico3/types.ts";
import {
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
	untilTerminal,
} from "./helpers.ts";

const delegate: ToolDeclaration = {
	name: "delegate",
	description: "",
	parameters: Type.Object({ v: Type.String() }),
	async execute(args, api, ctx) {
		const child = await api.conversation(
			{
				rewindable: { model, selectedTools: [], plugins: { forged: { child: true } } },
				sticky: { plugins: { forged: { child: true } } },
			},
			ctx,
		);
		const sent = await child.send({ content: `child task ${(args as { v: string }).v}` }, ctx);
		const r = await sent.wait(ctx);
		return {
			content: [{ type: "text", text: `child ${child.id} ${r.status}` }],
			details: { child: child.id, ...(r.answer === undefined ? {} : { answer: r.answer }) },
		};
	},
};

test("subagent: owned conversation, isolated config, answers, parent continues", async () => {
	const env = await open({
		tools: [delegate],
		models: fake({
			respond: (m) => {
				const last = lastMessage(m);
				if (last.role === "user" && String((last as { content: string }).content).startsWith("child task"))
					return { text: "child says hi" };
				return echoScript(m);
			},
		}),
	});
	onTestFinished(() => env.close());
	const a = await (await env.root.send({ content: "tool:delegate" }, ctx)).wait(ctx);
	await env.root.waitForIdle(ctx);
	assert.equal(a.status, "done");
	const tr = (await env.entries()).find((e) => e.kind === "pi.tool_result")!;
	const { child, answer } = (tr.data as { details: { child: number; answer: number } }).details;
	assert.match(contentOf(tr), /done/);
	const conv = (await env.root.commit((tx) => tx.conversation(child), ctx))!;
	const toolTask = (await env.tasks(1)).find((t) => t.kind === "pi.tool")!;
	assert.equal(conv.owner, toolTask.id);
	assert.deepEqual(toolTask.owns, [child]);
	assert.equal(conv.parent, undefined);
	assert.equal(kindsOf(await env.entries(child)), "user system assistant");
	assert.equal(
		contentOf((await env.entries(child)).find((e) => e.id === answer)),
		JSON.stringify([{ type: "text", text: "child says hi " }]),
	);
	const cr = await (await env.h.conversation(child, ctx))!.rewindable(ctx);
	assert.deepEqual(cr.plugins, {});
	assert.deepEqual((await (await env.h.conversation(child, ctx))!.sticky(ctx)).plugins, {});
	assert.deepEqual(cr.selectedTools, []);
	// subtree hooks reach the child
});

test("conversation abort reaches an owned child mid-stream; background children survive", async () => {
	const gate = new Gate();
	const isChild = (m: RequestMessage[]) => {
		const last = lastMessage(m);
		return last.role === "user" && String((last as { content: string }).content).startsWith("child task");
	};
	const env = await open({
		tools: [delegate],
		models: fake({ respond: (m) => (isChild(m) ? { text: "slow child" } : echoScript(m)), gate, gateWhen: isChild }),
	});
	onTestFinished(() => env.close());
	const a = await env.root.send({ content: "tool:delegate" }, ctx);
	await gate.arrivals(1); // the child's generation is blocked at the gate
	const live = (await env.tasks()).filter((t) => t.status !== "terminal");
	const childConv = live.find((t) => t.conversationId !== 1)!.conversationId;
	// a background job in the child survives conversation abort
	const bg = await env.root.commit(
		(tx) =>
			tx.createTask(kinds.plugin, { handler: "x", input: null }, { conversationId: childConv, background: true }).id,
		ctx,
	);
	await env.root.abort(ctx);
	assert.equal((await env.input(a.id))?.reason, "aborted");
	const after = await env.tasks();
	assert.equal(after.find((t) => t.kind === "pi.tool")!.outcome?.status, "aborted");
	const childGen = after.find((t) => t.conversationId === childConv && t.kind === "pi.generation")!;
	assert.equal(childGen.outcome?.status, "aborted");
	assert.ok(
		!(await env.entries(childConv)).some((e) => e.kind === "pi.assistant"),
		"gated before the first token: no partial, so no aborted assistant entry",
	);
	// the bg plugin task ran (no handler → failed), was not aborted
	assert.equal(failureOf(await untilTerminal(env, bg))?.reason, "missing_handler");
	assert.equal((await env.tasks()).filter((t) => t.status !== "terminal").length, 0);
});

test("subtree hooks: registered on the parent with subtree:true fire for the child", async () => {
	const seen: number[] = [];
	const env = await open({
		tools: [delegate],
		models: fake({
			respond: (m) => {
				const last = lastMessage(m);
				if (last.role === "user" && String((last as { content: string }).content).startsWith("child task"))
					return { text: "ok" };
				return echoScript(m);
			},
		}),
	});
	onTestFinished(() => env.close());
	const hookNamespace = env.h.namespace("test.subtree-hooks", {});
	env.root.hooks(
		hookNamespace,
		kinds.generation,
		{
			afterResponse: (_m, info) => {
				seen.push(info.conversationId);
			},
		},
		{ subtree: true },
	);
	await (await env.root.send({ content: "tool:delegate" }, ctx)).wait(ctx);
	await env.root.waitForIdle(ctx);
	assert.ok(seen.includes(1));
	assert.ok(
		seen.some((c) => c !== 1),
		`child response observed: ${seen}`,
	);
	// without subtree, only the parent
	const seen2: number[] = [];
	env.root.hooks(hookNamespace, kinds.generation, {
		afterResponse: (_m, info) => {
			seen2.push(info.conversationId);
		},
	});
	await (await env.root.send({ content: "tool:delegate" }, ctx)).wait(ctx);
	await env.root.waitForIdle(ctx);
	assert.deepEqual([...new Set(seen2)], [1]);
});

test("subtree hooks after reopen: ancestry is reconstructed from conversation owners (including a terminal owner task), not by matching ids", async () => {
	const respond = (m: RequestMessage[]) => {
		const last = lastMessage(m);
		if (last.role === "user" && String((last as { content: string }).content).startsWith("child task"))
			return { text: "ok" };
		return echoScript(m);
	};
	let env = await open({ backend: "jsonl", tools: [delegate], models: fake({ respond }) });
	onTestFinished(() => env.close());
	await (await env.root.send({ content: "tool:delegate" }, ctx)).wait(ctx);
	await env.root.waitForIdle(ctx);
	const child = (await env.root.commit((tx) => tx.tasks({}), ctx)).find((t) => t.kind === "pi.tool")!.owns[0]!;
	assert.ok(child !== undefined);
	await env.crash();
	env = await open({ dir: env.dir, backend: "jsonl", tools: [delegate], models: fake({ respond }) });
	const hookNamespace = env.h.namespace("test.reopened-subtree-hooks", {});
	const seen: number[] = [];
	env.root.hooks(
		hookNamespace,
		kinds.generation,
		{
			afterResponse: (_m, info) => {
				seen.push(info.conversationId);
			},
		},
		{ subtree: true },
	);
	const c = (await env.h.conversation(child, ctx))!;
	await (await c.send({ content: "child task again" }, ctx)).wait(ctx); // the owner tool task is long terminal
	assert.deepEqual(seen, [child]);
	const seen2: number[] = [];
	env.root.hooks(hookNamespace, kinds.generation, {
		afterResponse: (_m, info) => {
			seen2.push(info.conversationId);
		},
	});
	await (await c.send({ content: "child task once more" }, ctx)).wait(ctx);
	assert.deepEqual(seen2, []); // no subtree flag: the child is not the parent
});

test("task abort (not conversation abort) keeps queued input; a later idle send consumes it", async () => {
	const gate = new Gate();
	const env = await open({ models: fake({ respond: echoScript, gate }) });
	onTestFinished(() => env.close());
	const a = await env.root.send({ content: "A" }, ctx);
	await gate.arrivals(1);
	const f = await env.root.send({ content: "F" }, ctx);
	const gen = (await env.tasks()).find((t) => t.kind === "pi.generation")!;
	// abort the task through a plugin (the ToolApi has no abortTask; use a host commit + scheduler via harness.abortTask? not exposed) → mark + let the scheduler run fresh abort
	await env.h.markTask(gen.id, ctx);
	await untilTerminal(env, gen.id);
	assert.equal((await env.input(a.id))?.reason, "aborted");
	assert.equal((await env.input(f.id))?.status, "queued"); // survives task abort
	gate.open();
	const b = await env.root.send({ content: "B" }, ctx);
	await b.wait(ctx);
	await env.root.waitForIdle(ctx);
	assert.equal((await env.input(f.id))?.status, "done"); // placed by the idle send, before B
	const users = (await env.entries()).filter((e) => e.kind === "pi.user").map(contentOf);
	assert.deepEqual(users, ["A", "F", "B"]);
});

test("api.conversation({ inherit: true }) forks the tool's own conversation at its tip: transcript and rewindable inherited", async () => {
	const inheriting: ToolDeclaration = {
		name: "inherit",
		description: "",
		parameters: Type.Object({ v: Type.String() }),
		async execute(_a, api, ctx) {
			const child = await api.conversation({ inherit: true, rewindable: { selectedTools: [] } }, ctx);
			const r = await (await child.send({ content: "child task: what did we say?" }, ctx)).wait(ctx);
			return { content: [{ type: "text", text: `${child.id}:${r.status}` }], details: { child: child.id } };
		},
	};
	const env = await open({
		tools: [inheriting],
		models: fake({
			respond: (m) => {
				const last = lastMessage(m);
				if (last.role === "user" && String((last as { content: string }).content).startsWith("child task"))
					return { text: "we said hi" };
				return echoScript(m);
			},
		}),
	});
	onTestFinished(() => env.close());
	const state = env.h.namespace<{ marker: string }>("test.subagent-state", {
		rewindable: { marker: "" },
	});
	await env.root.commit((tx) => {
		tx.plugins(state).marker = "before";
	}, ctx);
	await (await env.root.send({ content: "hi" }, ctx)).wait(ctx);
	await env.root.commit((tx) => {
		tx.plugins(state).marker = "at-fork";
	}, ctx);
	await (await env.root.send({ content: "tool:inherit" }, ctx)).wait(ctx);
	await env.root.waitForIdle(ctx);
	const tr = (await env.entries()).find((e) => e.kind === "pi.tool_result")!;
	const child = (tr.data as { details: { child: number } }).details.child;
	const conv = (await env.root.commit((tx) => tx.conversation(child), ctx))!;
	assert.equal(conv.parent?.conversationId, 1);
	assert.equal(
		(await (await env.h.conversation(child, ctx))!.rewindable(ctx)).plugins["test.subagent-state"]?.marker,
		"at-fork",
	);
	assert.deepEqual((await (await env.h.conversation(child, ctx))!.rewindable(ctx)).selectedTools, []);
	const { entries } = await (await env.h.conversation(child, ctx))!.commit((tx) => tx.context(child), ctx);
	// inherited: user hi, system, assistant, user tool:inherit, system?, assistant(toolcall) … then the child's own user + assistant
	assert.ok(kindsOf(entries).startsWith("user system assistant user"));
	assert.ok(kindsOf(entries).endsWith("user system assistant") || kindsOf(entries).endsWith("user assistant"));
});
