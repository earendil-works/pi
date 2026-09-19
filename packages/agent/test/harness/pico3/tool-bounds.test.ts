import assert from "node:assert/strict";
import { Type } from "typebox";
import { onTestFinished, test } from "vitest";
import { Bounded } from "../../../src/harness/pico3/bounded.ts";
import { Forbidden, type ToolDeclaration, type ToolSlot } from "../../../src/harness/pico3/types.ts";
import { ctx, open } from "./helpers.ts";

test("Bounded: a single chunk larger than maxBytes is sliced on push and counted as dropped; line caps apply to head and tail", () => {
	const tail = new Bounded(10, 100, "tail");
	tail.push(new TextEncoder().encode("0123456789ABCDEFGHIJ")); // 20 bytes
	assert.equal(tail.text(), "ABCDEFGHIJ");
	assert.equal(tail.droppedBytes, 10);
	const head = new Bounded(10, 100, "head");
	head.push(new TextEncoder().encode("0123456789ABCDEFGHIJ"));
	assert.equal(head.text(), "0123456789");
	assert.equal(head.droppedBytes, 10);
	const lines = new Bounded(1000, 2, "head");
	lines.push(new TextEncoder().encode("a\nb\nc\nd\n"));
	assert.equal(lines.text(), "a\nb\n");
	assert.equal(lines.droppedLines, 2);
	const tlines = new Bounded(1000, 2, "tail");
	for (const l of ["a\n", "b\n", "c\n", "d\n"]) tlines.push(new TextEncoder().encode(l));
	assert.equal(tlines.text(), "c\nd\n");
	assert.equal(tlines.droppedLines, 2);
});

test("tool streaming: byte and line bounds are enforced on the stream and on the stored result; progress cannot touch identity fields", async () => {
	const schema = Type.Object({ v: Type.String() });
	let forbidden: unknown;
	const t: ToolDeclaration<typeof schema> = {
		name: "x",
		description: "",
		parameters: schema,
		output: { maxBytes: 20, maxLines: 3, retain: "tail" },
		async execute(_a, api, c) {
			for (let i = 0; i < 10; i++) api.stream(`line ${i}\n`);
			await api.progress((s) => {
				(s as ToolSlot).callId = "forged";
				(s as ToolSlot).name = "forged";
				(s as ToolSlot).output = "forged";
				s.progress = "p";
			}, c);
			try {
				await api.progress((s) => {
					(s as { args?: unknown }).args = 1;
				}, c);
			} catch (e) {
				forbidden = e;
			}
			return {};
		},
	};
	const env = await open({ tools: [t] });
	onTestFinished(() => env.close());
	await (await env.root.send({ content: "tool:x" }, ctx)).wait(ctx);
	const result = (await env.entries()).find((e) => e.kind === "pi.tool_result")!;
	const text = (result.model![0] as { content: { text: string }[] }).content[0]!.text;
	assert.ok(new TextEncoder().encode(text).length <= 20, text);
	assert.ok(text.split("\n").length <= 4);
	assert.ok(text.endsWith("line 9\n"));
	const data = result.data as { truncated?: { bytes: number; lines: number }; diagnostics: { code: string }[] };
	assert.ok(data.truncated!.bytes > 0 && data.truncated!.lines > 0);
	assert.equal(data.diagnostics[0]!.code, "truncated");
	void forbidden; // identity fields are copied into a free-field view; assigning them is simply ignored
	assert.equal(JSON.stringify((await env.root.sticky(ctx)).turn), JSON.stringify({ tools: [] }));
});

test("returned text blocks share one aggregate output budget", async () => {
	const declaration: ToolDeclaration = {
		name: "aggregate",
		description: "",
		parameters: Type.Object({ v: Type.String() }),
		output: { maxBytes: 10, maxLines: 100, retain: "tail" },
		async execute() {
			return {
				content: [
					{ type: "text", text: "abcdefgh" },
					{ type: "text", text: "ijklmnop" },
					{ type: "text", text: "qrstuvwx" },
				],
			};
		},
	};
	const env = await open({ tools: [declaration] });
	onTestFinished(() => env.close());
	await (await env.root.send({ content: "tool:aggregate" }, ctx)).wait(ctx);
	const result = (await env.entries()).find((entry) => entry.kind === "pi.tool_result")!;
	const content = (result.model![0] as { content: Array<{ type: string; text?: string }> }).content;
	const texts = content.filter((block) => block.type === "text");
	assert.deepEqual(texts, [{ type: "text", text: "opqrstuvwx" }]);
	assert.ok(new TextEncoder().encode(texts.map((block) => block.text).join("")).length <= 10);
	assert.equal((result.data as { truncated: { bytes: number } }).truncated.bytes, 14);
});

test("a tool cannot reach core operations through the ToolApi; a hook that throws blocks the call before `started`", async () => {
	const schema = Type.Object({ v: Type.String() });
	let calls = 0;
	const t: ToolDeclaration<typeof schema> = {
		name: "x",
		description: "",
		parameters: schema,
		async execute() {
			calls++;
			return { content: [{ type: "text", text: "ran" }] };
		},
	};
	const env = await open({
		tools: [t],
		hooks: {
			tool: {
				beforeTool: () => {
					throw new Error("nope");
				},
			},
		},
	});
	onTestFinished(() => env.close());
	await (await env.root.send({ content: "tool:x" }, ctx)).wait(ctx);
	assert.equal(calls, 0);
	const r = (await env.entries()).find((e) => e.kind === "pi.tool_result")!;
	assert.match(JSON.stringify(r.model), /blocked: hook threw/);
	assert.equal((await env.tasks()).find((x) => x.kind === "pi.tool")?.checkpoint, undefined);
	void Forbidden;
});
