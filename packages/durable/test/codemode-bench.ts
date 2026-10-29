/**
 * Durable code mode overhead. One model-issued call makes N calls of a trivial `echo` tool, either sequentially or all at
 * once, in two ways: a code mode script (`tools.echo()`, journaled and replayable) and a plain tool calling
 * `api.executeTool()` the same way (nested calls, no journal). Reports wall time and commits per call on SQLite.
 *
 *   node --conditions=source --experimental-strip-types test/codemode-bench.ts [N,...]
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { Type } from "typebox";
import { createCodemodeTool } from "../src/codemode/codemode.ts";
import { createRegistry, defineExtension, defineTool, Harness } from "../src/index.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";

type Shape = "sequential" | "parallel";

const echo = defineTool({
	name: "echo",
	description: "echo",
	parameters: Type.Object({ i: Type.Number() }),
	execute: async (args) => ({ output: [{ type: "text", text: String(args.i) }] }),
});

const plain = defineTool({
	name: "plain",
	description: "plain",
	parameters: Type.Object({ n: Type.Number(), shape: Type.String() }),
	replay: "safe",
	execute: async (args, api, callContext) => {
		if (args.shape === "sequential") {
			for (let i = 0; i < args.n; i++) await api.executeTool("echo", { i }, callContext);
		} else {
			await Promise.all(Array.from({ length: args.n }, (_, i) => api.executeTool("echo", { i }, callContext)));
		}
		return { output: [{ type: "text", text: "done" }] };
	},
});

async function run(mode: "codemode" | "plain", shape: Shape, n: number): Promise<{ ms: number; commits: number }> {
	const directory = await mkdtemp(join(tmpdir(), "pi-codemode-bench-"));
	try {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const sandbox = new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 });
		const registry = createRegistry();
		registry.install(defineExtension({ name: "bench", tools: [echo, plain, createCodemodeTool({ sandbox })] }));
		const code =
			shape === "sequential"
				? `for (let i = 0; i < ${n}; i++) await tools.echo({ i }); return "done";`
				: `await Promise.all(Array.from({ length: ${n} }, (_, i) => tools.echo({ i }))); return "done";`;
		const call =
			mode === "codemode"
				? fauxToolCall("codemode", { code }, { id: "c1" })
				: fauxToolCall("plain", { n, shape }, { id: "c1" });
		faux.setResponses([
			fauxAssistantMessage([call], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("ok")]),
		]);
		const storage = await openNodeSqliteStorage(join(directory, "session.sqlite"));
		const harness = await Harness.open(storage, { models, registry, settings: {} }, context);
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		let commits = 0;
		harness.observeCommits({
			advance: () => {
				commits++;
			},
			end: () => {},
		});
		const started = performance.now();
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		const ms = performance.now() - started;
		await harness.close(context);
		await sandbox.close();
		return { ms, commits };
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

const sizes = (process.argv[2] ?? "100,1000").split(",").map(Number);
for (const shape of ["sequential", "parallel"] as const) {
	for (const n of sizes) {
		const plainRun = await run("plain", shape, n);
		const codemodeRun = await run("codemode", shape, n);
		const per = (value: number) => (value / n).toFixed(2);
		console.log(
			`${shape} n=${n}: plain ${plainRun.ms.toFixed(0)} ms (${per(plainRun.ms)} ms, ${per(plainRun.commits)} commits/call), codemode ${codemodeRun.ms.toFixed(0)} ms (${per(codemodeRun.ms)} ms, ${per(codemodeRun.commits)} commits/call)`,
		);
	}
}
