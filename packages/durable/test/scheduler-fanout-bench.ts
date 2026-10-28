/**
 * Scheduler fan-out benchmark. One model-issued tool makes `calls` parallel nested calls of a tool that returns at
 * once, on in-memory storage, so the time is the Harness's and the scheduler's own. Quadratic work shows as four times
 * the time per doubling of `calls`.
 *
 *   node --conditions=source --experimental-strip-types test/scheduler-fanout-bench.ts [calls...]
 */
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { createRegistry, defineExtension, defineTool, Harness, ToolResultEntry } from "../src/index.ts";
import { MemoryStorage } from "../src/storage/memory.ts";

async function run(calls: number): Promise<{ ms: number; commits: number }> {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	const leaf = defineTool({
		name: "leaf",
		description: "Return at once",
		parameters: Type.Object({ n: Type.Number() }),
		execute: async () => ({ output: [{ type: "text", text: "ok" }] }),
	});
	const fan = defineTool({
		name: "fan",
		description: "Call leaf in parallel",
		parameters: Type.Object({ count: Type.Number() }),
		execute: async (args, api, callContext) => {
			const results = await Promise.all(
				Array.from({ length: args.count }, (_, n) =>
					api.executeTool("leaf", { n }, callContext, { progress: false }),
				),
			);
			const failed = results.filter((result) => result.isError).length;
			return { output: [{ type: "text", text: `${failed} failed` }], isError: failed > 0 };
		},
	});
	registry.install(defineExtension({ name: "bench", tools: [leaf, fan] }));
	const storage = new MemoryStorage();
	let commits = 0;
	const commit = storage.commit.bind(storage);
	storage.commit = (writes, adopt, commitContext) => {
		commits++;
		return commit(writes, adopt, commitContext);
	};
	const harness = await Harness.open(storage, { models, registry }, context);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("fan", { count: calls }, { id: "fan" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("done")]),
	]);
	const started = performance.now();
	const settled = await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
	if (settled.status !== "done") throw new Error(`run: ${settled.status}`);
	await harness.waitForIdle(context);
	const ms = Math.round(performance.now() - started);
	// A run whose nested calls failed measures nothing.
	const page = await root.entries({}, 10, undefined, context);
	const result = page.items.find((entry) => ToolResultEntry.is(entry))?.model?.[0];
	if (result?.role !== "toolResult" || result.isError) throw new Error(`run: nested calls failed`);
	await harness.close(context);
	return { ms, commits };
}

const sizes = process.argv.slice(2).map(Number);
console.log("calls | ms     | commits | ms per call");
for (const calls of sizes.length > 0 ? sizes : [250, 500, 1000, 2000, 4000]) {
	const { ms, commits } = await run(calls);
	console.log(
		`${String(calls).padEnd(5)} | ${String(ms).padEnd(6)} | ${String(commits).padEnd(7)} | ${(ms / calls).toFixed(2)}`,
	);
}
