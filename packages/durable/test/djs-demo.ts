// Durable code mode on djs, across two processes (prototype).
//
//   node --conditions=source test/djs-demo.ts start    # the script runs, calls a tool that parks on a person, parks
//   node --conditions=source test/djs-demo.ts answer   # a new process: the person answers, the script continues
//   node --conditions=source test/djs-demo.ts crash    # the script runs; the process dies while a tool runs
//   node --conditions=source test/djs-demo.ts recover  # a new process: recovery resumes the last dump
//
// DJS_WASM (and DJS_DUMP_WASM) name djs-wasm; DEMO_DB the SQLite file (default /tmp/pi-djs-demo/session.sqlite).
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { DjsCodemode } from "@earendil-works/pi-codemode/djs";
import {
	defineExtension,
	defineSignal,
	defineTool,
	ToolResultEntry,
	ToolTask,
	type ToolTaskInput,
} from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { createCodemodeTool } from "../src/codemode/codemode.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, chatSetup, openChat, waitFor } from "./chat-support.ts";
import { addTool } from "./harness-support.ts";
import { context } from "./session-support.ts";

const db = process.env.DEMO_DB ?? "/tmp/pi-djs-demo/session.sqlite";
const phase = process.argv[2];

const Answer = defineSignal({ name: "demo.answer", version: 1, schema: obj({ text: str() }) });

const SCRIPT = `
import { search_issues as search } from "@mcp/github";
const notes = new Map();
const read = tools.echo;
for (const issue of (await search({ q: "dumps" })).split("\\n")) notes.set(issue, await read({ text: issue }));
console.log("collected", notes.size, "notes;", ALL_TOOLS.length, "tools");
const [answer, ci] = await Promise.all([
  tools.ask({ question: "Ship it? " + [...notes.values()].join(", ") }),
  tools.echo({ text: "ci passed" }),
]);
text("the person said: " + answer + "; " + ci);
store("decision", { answer });
return { answer, notes: Object.fromEntries(notes), sameFunction: read === tools.echo };
`;

const CRASH_SCRIPT = `
const first = await tools.echo({ text: "before the crash" });
const slow = await tools.slow({ text: "survives" });
return [first, slow];
`;

const setup = chatSetup();
const djs = await DjsCodemode.load();
const crashing = phase === "crash" || phase === "recover";
addTool(setup.registry, createCodemodeTool({ djs, parkAfterMs: crashing ? 60_000 : 50 }));
setup.registry.install(
	defineExtension({
		name: "github",
		namespace: { name: "@mcp/github", description: "GitHub, as an MCP server would offer it" },
		tools: [
			defineTool({
				name: "search_issues",
				description: "Search issues",
				parameters: obj({ q: str() }),
				replay: "safe",
				execute: async (args) => {
					console.log(`  [search_issues] ${args.q}`);
					return { output: [{ type: "text", text: "#12 dump format\n#15 park on signals" }] };
				},
			}),
		],
	}),
);
addTool(
	setup.registry,
	defineTool({
		name: "slow",
		description: "Takes a while",
		parameters: obj({ text: str() }),
		replay: "safe",
		execute: async (args) => {
			console.log(`  [slow] starts (pid ${process.pid})`);
			if (phase === "crash") {
				console.log("  process dies while slow runs");
				process.exit(0);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
			return { output: [{ type: "text", text: `slow ${args.text}` }] };
		},
	}),
);
addTool(
	setup.registry,
	defineTool({
		name: "echo",
		description: "Echo a text",
		parameters: obj({ text: opt(str()) }),
		replay: "safe",
		execute: async (args) => {
			console.log(`  [echo] ${args.text} (pid ${process.pid})`);
			return { output: [{ type: "text", text: `echo ${args.text ?? ""}` }] };
		},
	}),
);
addTool(
	setup.registry,
	defineTool({
		name: "ask",
		description: "Ask a person; parks until they answer",
		parameters: obj({ question: str() }),
		replay: "safe",
		execute: async (args, api, ctx) => {
			const state = await api.readSignal(Answer, "answer", ctx);
			if (state?.kind === "value") return { output: [{ type: "text", text: state.value.text }] };
			console.log(`  [ask] parks on a person: ${JSON.stringify(args.question)}`);
			return { kind: "sleep", signals: [Answer.key("answer")] };
		},
	}),
);

async function nestedTask(harness: Awaited<ReturnType<typeof openChat>>["harness"], name: string) {
	const tasks = (await harness.commit((tx) => tx.scanTasks({ kind: ToolTask.definition.name }, 100), context)).items;
	return tasks.find(
		(task) =>
			(task.input as ToolTaskInput).kind === "nested" &&
			(task.input as { call: { name: string } }).call.name === name,
	);
}

if (phase === "start") {
	rmSync(dirname(db), { recursive: true, force: true });
	mkdirSync(dirname(db), { recursive: true });
	setup.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("codemode", { code: SCRIPT }, { id: "s1" })], { stopReason: "toolUse" }),
	]);
	const { harness, root } = await openChat(await openNodeSqliteStorage(db), setup);
	harness.resume();
	await root.submit({ type: "input", content: "go" }, context);
	await waitFor(async () => (await nestedTask(harness, "ask"))?.state.status === "sleeping", 10_000);
	await waitFor(() => !harness.wake().active, 10_000);
	const tasks = (await harness.commit((tx) => tx.scanTasks({ kind: ToolTask.definition.name }, 100), context)).items;
	for (const task of tasks) {
		const input = task.input as ToolTaskInput & { call?: { name: string } };
		console.log(`  task ${task.id}: ${input.kind} ${input.call?.name ?? ""} -> ${task.state.status}`);
	}
	console.log("  wake():", JSON.stringify(harness.wake()));
	await harness.close(context);
	console.log("parked; process exits");
} else if (phase === "answer") {
	setup.faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
	const { harness, root } = await openChat(await openNodeSqliteStorage(db), setup);
	harness.resume();
	const ask = await nestedTask(harness, "ask");
	console.log("  signal:", await harness.signal(ask!.id, Answer, "answer", { text: "yes, ship it" }, context));
	await waitFor(async () => (await allEntries(root)).some((entry) => ToolResultEntry.is(entry)), 10_000);
	const entry = (await allEntries(root)).find((candidate) => ToolResultEntry.is(candidate))!;
	const result = entry.model![0] as { content: { type: string; text?: string }[]; isError: boolean };
	console.log(`  code mode result (isError ${result.isError}):`);
	for (const item of result.content) console.log(`    ${item.text?.split("\n").join("\n    ")}`);
	await harness.close(context);
} else if (phase === "crash") {
	rmSync(dirname(db), { recursive: true, force: true });
	mkdirSync(dirname(db), { recursive: true });
	setup.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("codemode", { code: CRASH_SCRIPT }, { id: "s1" })], { stopReason: "toolUse" }),
	]);
	const { harness, root } = await openChat(await openNodeSqliteStorage(db), setup);
	harness.resume();
	await root.submit({ type: "input", content: "go" }, context);
	await new Promise(() => {});
} else if (phase === "recover") {
	setup.faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
	const { harness, root } = await openChat(await openNodeSqliteStorage(db), setup);
	harness.resume();
	await waitFor(async () => (await allEntries(root)).some((entry) => ToolResultEntry.is(entry)), 10_000);
	const entry = (await allEntries(root)).find((candidate) => ToolResultEntry.is(candidate))!;
	const result = entry.model![0] as { content: { type: string; text?: string }[]; isError: boolean };
	console.log(`  code mode result (isError ${result.isError}):`);
	for (const item of result.content) console.log(`    ${item.text?.split("\n").join("\n    ")}`);
	await harness.close(context);
} else {
	console.error("usage: djs-demo.ts start|answer|crash|recover");
	process.exit(2);
}
