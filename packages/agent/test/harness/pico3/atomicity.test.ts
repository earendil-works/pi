import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { onTestFinished, test } from "vitest";
import { kinds } from "../../../src/harness/pico3/harness.ts";
import { JsonlStorage } from "../../../src/harness/pico3/jsonl.ts";
import { defineTask, type Namespace, type ToolDeclaration } from "../../../src/harness/pico3/types.ts";
import { ctx, echoScript, fake, Gate, open, untilPhase } from "./helpers.ts";

/** Drop the last `n` records of a file: simulates a crash after the other files of a commit were fsync'd. */
const chop = (file: string, n: number) => {
	const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
	writeFileSync(
		file,
		lines
			.slice(0, lines.length - n)
			.map((l) => `${l}\n`)
			.join(""),
	);
};
const last = (file: string) =>
	JSON.parse(readFileSync(file, "utf8").trim().split("\n").pop()!) as {
		seq: number;
		refs?: string[];
		writes: { type: string }[];
	};

test("multi-file commit torn before main → the sidecar half is discarded on replay (no inbox item without its Input)", async () => {
	const gate = new Gate();
	let env = await open({ backend: "jsonl", models: fake({ respond: echoScript, gate }) });
	onTestFinished(() => env.close());
	const a = await env.root.send({ content: "A" }, ctx);
	await gate.arrivals(1);
	const f = await env.root.send({ content: "F" }, ctx); // busy → queued: one commit writing sticky (inbox) + main (Input)
	await env.crash();
	const sticky = last(join(env.dir!, "sticky-1.jsonl"));
	assert.equal(last(join(env.dir!, "main.jsonl")).seq, sticky.seq); // main half landed…
	chop(join(env.dir!, "main.jsonl"), 1); // …until we tear it off: sticky fsync'd, main not
	env = await open({ dir: env.dir, backend: "jsonl", models: fake({ respond: echoScript }) });
	assert.equal(await env.input(f.id), undefined); // the Input never existed
	assert.deepEqual((await env.root.sticky(ctx)).inbox, []); // and the inbox does not reference it
	await env.root.waitForIdle(ctx);
	assert.equal((await env.input(a.id))?.status, "done"); // the earlier commit is intact
});

test("checkpoint before an effect: marker landed → durable, the effect does not rerun; marker torn → dropped, the effect reruns (it never started)", async () => {
	const gate = new Gate();
	const t: ToolDeclaration & { calls: number } = {
		calls: 0,
		name: "x",
		description: "",
		parameters: Type.Object({ v: Type.String() }),
		replay: "unsafe",
		async execute(_a, _api, c) {
			t.calls++;
			await gate.wait(c);
			return { content: [{ type: "text", text: "ran" }] };
		},
	};
	let env = await open({ backend: "jsonl", tools: [t] });
	onTestFinished(() => env.close());
	await env.root.send({ content: "tool:x" }, ctx);
	const task = await untilPhase(env, "pi.tool", "started");
	await gate.arrivals(1);
	await env.crash();
	const rec = last(join(env.dir!, `task-${task.id}.jsonl`));
	const marker = last(join(env.dir!, "main.jsonl"));
	assert.equal(marker.seq, rec.seq); // the marker is the publication point
	assert.deepEqual([...marker.refs!].sort(), [`sticky-1.jsonl`, `task-${task.id}.jsonl`].sort());
	assert.deepEqual(marker.writes, []);
	// (a) intact: replay restores `started`; replay "unsafe" → synthetic interrupted result, NOT a second run
	const t2 = { ...t, calls: 0 };
	env = await open({ dir: env.dir, backend: "jsonl", tools: [t2] });
	await env.root.waitForIdle(ctx);
	assert.equal(t2.calls, 0);
	assert.match(JSON.stringify((await env.entries()).find((e) => e.kind === "pi.tool_result")!.model), /interrupted/);
});

test("checkpoint before an effect, marker torn: the checkpoint is dropped and the phase runs from initial; the effect never ran, so this is safe", async () => {
	const gate = new Gate();
	const t: ToolDeclaration & { calls: number } = {
		calls: 0,
		name: "x",
		description: "",
		parameters: Type.Object({ v: Type.String() }),
		replay: "unsafe",
		async execute(_a, _api, c) {
			t.calls++;
			await gate.wait(c);
			return { content: [{ type: "text", text: "ran" }] };
		},
	};
	let env = await open({ backend: "jsonl", tools: [t] });
	onTestFinished(() => env.close());
	await env.root.send({ content: "tool:x" }, ctx);
	const task = await untilPhase(env, "pi.tool", "started");
	await gate.arrivals(1);
	await env.crash();
	chop(join(env.dir!, "main.jsonl"), 1); // sidecar fsync'd, marker not
	const s = await JsonlStorage.open(env.dir!, { fsync: false });
	assert.equal((await s.task(task.id, ctx))?.checkpoint, undefined); // unconfirmed sidecar record ignored
	await s.close();
	env = await open({ dir: env.dir, backend: "jsonl", tools: [t] });
	await untilPhase(env, "pi.tool", "started");
	await gate.arrivals(2);
	assert.equal(t.calls, 2); // once per process. (In a real crash the marker and the commit return are the same event, so a missing marker means execute never started; here the chop simulates that.)
	gate.open();
	await env.root.waitForIdle(ctx);
	assert.match(JSON.stringify((await env.entries()).find((e) => e.kind === "pi.tool_result")!.model), /ran/);
});

test("an unpublished sidecar tail is truncated before its sequence is reused", async () => {
	let env = await open({ backend: "jsonl" });
	onTestFinished(() => env.close());
	await env.root.config.set({ followUpMode: "all" } as never, ctx);
	await env.crash();
	assert.deepEqual(last(join(env.dir!, "main.jsonl")).refs, ["sticky-1.jsonl"]);
	chop(join(env.dir!, "main.jsonl"), 1); // sticky N remains, but publication N is gone

	env = await open({ dir: env.dir, backend: "jsonl" });
	assert.equal((await env.root.sticky(ctx)).followUpMode, "one-at-a-time");
	await env.root.config.set({ followUpMode: "all" } as never, ctx); // safely reuse N after replay truncated the old tail
	await env.crash();

	env = await open({ dir: env.dir, backend: "jsonl" }); // the duplicate-N poison used to fail here
	assert.equal((await env.root.sticky(ctx)).followUpMode, "all");
	const sequences = readFileSync(join(env.dir!, "sticky-1.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => (JSON.parse(line) as { seq: number }).seq);
	for (let index = 1; index < sequences.length; index++) assert.ok(sequences[index]! > sequences[index - 1]!);
});

test("a third-party kind's checkpoint + sticky write in one commit spans two sidecars → one marker; marker torn → both halves dropped together", async () => {
	const gate = new Gate();
	const ran: string[] = [];
	let state!: Namespace<{ mark: string }>;
	const k = defineTask<null, { phase: "a" } | { phase: "b" }, null, never, null>({
		name: "two-files",
		async initial() {
			return { next: { phase: "a" } };
		},
		phases: {
			async a(_t, rt, c) {
				ran.push("a");
				await rt.commit((tx) => {
					tx.checkpoint({ phase: "b" });
					tx.plugins(state).mark = "b";
				}, c); // task sidecar + sticky sidecar, no main
				await gate.wait(c);
				return { done: () => ({ status: "completed", result: null }) };
			},
			async b(_t, _rt, c) {
				ran.push("b");
				await gate.wait(c);
				return { done: () => ({ status: "completed", result: null }) };
			},
		},
		async abort() {
			return () => null;
		},
	});
	const setup = (harness: Parameters<NonNullable<Parameters<typeof open>[0]["setup"]>>[0]) => {
		state = harness.namespace("test.atomicity", { sticky: { mark: "initial" } });
	};
	let env = await open({ backend: "jsonl", taskKinds: [k], setup });
	onTestFinished(() => env.close());
	const ref = await env.root.commit((tx) => tx.createTask(k, null, { conversationId: 1, background: true }), ctx);
	await gate.arrivals(1);
	await env.crash();
	const main = last(join(env.dir!, "main.jsonl"));
	assert.deepEqual(main.writes, []); // a marker with no main-table writes
	assert.deepEqual([...main.refs!].sort(), [`sticky-1.jsonl`, `task-${ref.id}.jsonl`].sort());
	assert.equal(main.seq, last(join(env.dir!, `task-${ref.id}.jsonl`)).seq);
	assert.equal(main.seq, last(join(env.dir!, "sticky-1.jsonl")).seq);
	// intact: replay sees phase b and the mark; the scheduler resumes INTO b
	env = await open({ dir: env.dir, backend: "jsonl", taskKinds: [k], setup });
	await gate.arrivals(2);
	assert.deepEqual(ran, ["a", "b"]);
	assert.equal((await env.root.sticky(ctx)).plugins["test.atomicity"]?.mark, "b");
	await env.crash();
	// torn: drop the horizon record → both sidecar halves are beyond the horizon and discarded together
	assert.deepEqual(last(join(env.dir!, "main.jsonl")).writes, []); // a reopen that only reads appends nothing
	chop(join(env.dir!, "main.jsonl"), 1);
	// Open storage alone to see what replay restored, before any scheduler runs.
	const s = await JsonlStorage.open(env.dir!, { fsync: false });
	assert.equal((await s.task(ref.id, ctx))?.checkpoint?.phase, "a"); // the `b` record has no marker: dropped
	assert.equal(
		(
			(await s.doc({ doc: "sticky", conversationId: 1 }, ctx)) as {
				plugins: { "test.atomicity"?: { mark?: string } };
			}
		).plugins["test.atomicity"]?.mark,
		undefined,
	); // and so was its sticky half
	await s.close();
	// Resuming redoes phase a, which writes the pair again: the torn commit is repeated, not lost or half-applied.
	env = await open({ dir: env.dir, backend: "jsonl", taskKinds: [k], setup });
	await gate.arrivals(3);
	assert.deepEqual(ran, ["a", "b", "a"]);
	assert.equal((await env.root.sticky(ctx)).plugins["test.atomicity"]?.mark, "b");
	gate.open();
});

test("torn tail: bytes after the last newline are truncated on open; a later append starts a fresh line", async () => {
	let env = await open({ backend: "jsonl" });
	onTestFinished(() => env.close());
	await env.root.write({ kind: "note" }, ctx);
	await env.crash();
	appendFileSync(join(env.dir!, "main.jsonl"), '{"seq":99,"maxId":9,"wri');
	env = await open({ dir: env.dir, backend: "jsonl" });
	await env.root.write({ kind: "note" }, ctx);
	await env.crash();
	const lines = readFileSync(join(env.dir!, "main.jsonl"), "utf8").split("\n").filter(Boolean);
	for (const l of lines) JSON.parse(l); // every line is a complete record
	env = await open({ dir: env.dir, backend: "jsonl" });
	assert.equal((await env.entries()).filter((e) => e.kind === "note").length, 2);
});

test("a malformed complete record fails open; a stale sidecar for a terminal task cannot resurrect state", async () => {
	let env = await open({ backend: "jsonl" });
	onTestFinished(() => env.close());
	const ref = await env.root.commit(
		(tx) => tx.createTask(kinds.plugin, { handler: "none", input: null }, { conversationId: 1, background: true }),
		ctx,
	);
	await env.h.waitForTask(ref.id, ctx);
	await env.crash();
	// stale sidecar: a `running` record for the now-terminal task
	writeFileSync(
		join(env.dir!, `task-${ref.id}.jsonl`),
		`${JSON.stringify({ seq: 1, maxId: 1, writes: [{ type: "task.patch", patch: { id: ref.id, status: "running", checkpoint: { phase: "started" } } }] })}\n`,
	);
	env = await open({ dir: env.dir, backend: "jsonl" });
	assert.equal((await env.h.getTask(ref.id, ctx))?.status, "terminal");
	await env.crash();
	appendFileSync(join(env.dir!, "main.jsonl"), `${JSON.stringify({ seq: 1, maxId: 1, writes: [] })}\n`); // non-monotonic seq, complete line
	await assert.rejects(JsonlStorage.open(env.dir!, { fsync: false }), /sequence not increasing/);
	const good = readFileSync(join(env.dir!, "main.jsonl"), "utf8").split("\n").filter(Boolean);
	writeFileSync(
		join(env.dir!, "main.jsonl"),
		`${good
			.slice(0, -1)
			.map((l) => `${l}\n`)
			.join("")}{"seq":"x"}\n`,
	);
	await assert.rejects(JsonlStorage.open(env.dir!, { fsync: false }), /lacks seq/);
	writeFileSync(
		join(env.dir!, "main.jsonl"),
		good
			.slice(0, -1)
			.map((l) => `${l}\n`)
			.join(""),
	);
});
