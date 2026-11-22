// Code mode on djs (prototype): a script that waits on a parked tool parks with its dump; a reopened Harness resumes
// the dump; a script that holds what a dump cannot write ends with an error. Needs DJS_WASM (and DJS_DUMP_WASM).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { DjsCodemode } from "@earendil-works/pi-codemode/djs";
import { defineSignal, defineTool, type Harness, ToolResultEntry, ToolTask } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { afterEach, describe, expect, it } from "vitest";
import { createCodemodeTool } from "../src/codemode/codemode.ts";
import { CodemodeSavedDoc } from "../src/codemode/djs-call.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, type ChatSetup, chatSetup, openChat, waitFor } from "./chat-support.ts";
import { addTool } from "./harness-support.ts";
import { context } from "./session-support.ts";

const Answer = defineSignal({ name: "test.answer", version: 1, schema: obj({ text: str() }) });
const directories = new Set<string>();
afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-djs-"));
	directories.add(directory);
	return join(directory, "session.sqlite");
}

function setupWith(djs: DjsCodemode, echoes: string[]): ChatSetup {
	const setup = chatSetup();
	addTool(setup.registry, createCodemodeTool({ djs, parkAfterMs: 20 }));
	addTool(
		setup.registry,
		defineTool({
			name: "echo",
			description: "echo",
			parameters: obj({ text: opt(str()) }),
			replay: "safe",
			execute: async (args) => {
				echoes.push(args.text ?? "");
				return { output: [{ type: "text", text: `echo ${args.text ?? ""}` }] };
			},
		}),
	);
	addTool(
		setup.registry,
		defineTool({
			name: "ask",
			description: "ask a person",
			parameters: obj({}),
			replay: "safe",
			execute: async (_args, api, ctx) => {
				const state = await api.readSignal(Answer, "a", ctx);
				if (state?.kind === "value") return { output: [{ type: "text", text: state.value.text }] };
				return { kind: "sleep", signals: [Answer.key("a")] };
			},
		}),
	);
	return setup;
}

const djsReady = process.env.DJS_WASM !== undefined;

async function nested(harness: Harness, name: string) {
	const tasks = (await harness.commit((tx) => tx.scanTasks({ kind: ToolTask.definition.name }, 100), context)).items;
	return tasks.find((task) => (task.input as { call?: { name: string } }).call?.name === name);
}

async function resultText(root: Awaited<ReturnType<typeof openChat>>["root"]) {
	await waitFor(async () => (await allEntries(root)).some((entry) => ToolResultEntry.is(entry)), 10_000);
	const entry = (await allEntries(root)).find((candidate) => ToolResultEntry.is(candidate))!;
	const message = entry.model![0] as { content: { type: string; text?: string }[]; isError: boolean };
	return { isError: message.isError, text: message.content.map((item) => item.text ?? "").join("\n") };
}

describe.runIf(djsReady)("code mode on djs", () => {
	it("parks with its dump while a nested call is parked, and resumes it after a reopen", async () => {
		const path = await sqlitePath();
		const echoes: string[] = [];
		const code = `const a = await tools.echo({ text: "one" });
const answer = await tools.ask({});
return [a, answer, await tools.echo({ text: "two" })];`;
		let setup = setupWith(await DjsCodemode.load(), echoes);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "s1" })], { stopReason: "toolUse" }),
		]);
		let opened = await openChat(await openNodeSqliteStorage(path), setup);
		opened.harness.resume();
		await opened.root.submit({ type: "input", content: "go" }, context);
		await waitFor(async () => (await nested(opened.harness, "ask"))?.state.status === "sleeping");
		const script = (
			await opened.harness.commit((tx) => tx.scanTasks({ kind: ToolTask.definition.name }, 100), context)
		).items.find((task) => (task.input as { kind: string }).kind === "model")!;
		await waitFor(async () => (await opened.harness.getTask(script.id, context))?.state.status === "waiting");
		await waitFor(() => !opened.harness.wake().active);
		const saved = await opened.harness.snapshot(CodemodeSavedDoc, script.id, context);
		expect(saved?.saved).toMatchObject({ v: 1, engine: "djs" });
		expect(saved?.saved?.dump).toContain('$djs.resume(2, "tools.ask", [{}])');
		// Self-contained: the script's body is in the dump, not referred to by hash.
		expect(saved?.saved?.dump).not.toContain("$djs.source");
		await opened.harness.close(context);

		// Another process: a new djs module instance, the same database.
		setup = setupWith(await DjsCodemode.load(), echoes);
		setup.faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
		opened = await openChat(await openNodeSqliteStorage(path), setup);
		opened.harness.resume();
		const ask = await nested(opened.harness, "ask");
		expect(await opened.harness.signal(ask!.id, Answer, "a", { text: "yes" }, context)).toBe("delivered");
		expect(await resultText(opened.root)).toMatchObject({
			isError: false,
			text: expect.stringContaining('["echo one","yes","echo two"]'),
		});
		// Nothing ran twice.
		expect(echoes).toEqual(["one", "two"]);
		await opened.harness.close(context);
	});

	it("parks again on the calls still parked after one of them ends", async () => {
		const setup = setupWith(await DjsCodemode.load(), []);
		const code = `const [a, b] = await Promise.all([tools.ask({}), tools.ask({})]); return a + "+" + b;`;
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "s1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(await openNodeSqliteStorage(await sqlitePath()), setup);
		harness.resume();
		await root.submit({ type: "input", content: "go" }, context);
		const asks = async () =>
			(await harness.commit((tx) => tx.scanTasks({ kind: ToolTask.definition.name }, 100), context)).items.filter(
				(task) => (task.input as { call?: { name: string } }).call?.name === "ask",
			);
		const script = async () =>
			(await harness.commit((tx) => tx.scanTasks({ kind: ToolTask.definition.name }, 100), context)).items.find(
				(task) => (task.input as { kind: string }).kind === "model",
			)!;
		await waitFor(async () => (await script())?.state.status === "waiting");
		const [first, second] = await asks();
		expect((await script()).state).toMatchObject({ on: [first!.id, second!.id], policy: "any" });
		await harness.signal(second!.id, Answer, "a", { text: "B" }, context);
		await waitFor(async () => {
			const state = (await script()).state as { status: string; on?: unknown[] };
			return state.status === "waiting" && state.on?.length === 1;
		});
		expect((await script()).state).toMatchObject({ status: "waiting", on: [first!.id] });
		await harness.signal(first!.id, Answer, "a", { text: "A" }, context);
		expect((await resultText(root)).text).toContain("A+B");
		await harness.close(context);
	});

	it("runs a script that holds what a dump cannot write in memory only, and never parks it", async () => {
		const setup = setupWith(await DjsCodemode.load(), []);
		const code = `const seen = new WeakMap(); seen.set({}, 1); await tools.echo({ text: "x" }); return "kept " + typeof seen;`;
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "s1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(await openNodeSqliteStorage(await sqlitePath()), setup);
		harness.resume();
		await root.submit({ type: "input", content: "go" }, context);
		expect(await resultText(root)).toMatchObject({ isError: false, text: expect.stringContaining("kept object") });
		await harness.close(context);
	});

});
