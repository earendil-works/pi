// Run the project's tests at the end of every run that edited files, with an `afterRun` hook: the run waits for the
// tests, a failure starts a fix run, and input sent meanwhile waits for them too.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/32-tests-after-edits.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	createRegistry,
	defineExtension,
	defineTask,
	defineTool,
	GenerationTask,
	Harness,
	hook,
	LiveDoc,
	MemoryStorage,
	runEndTask,
	ToolResultEntry,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// ─── Product code: the project, an edit tool, and the test runner ─────────────

// The project under test, in memory: the tests pass once `add` adds.
const files = new Map([["math.ts", "export const add = (a, b) => a - b;"]]);
const runTests = () => {
	const passed = files.get("math.ts")!.includes("a + b");
	return { passed, output: passed ? "1 passed" : "add(1, 2): expected 3, got -1" };
};

const edit = defineTool({
	name: "edit",
	description: "Replace a file's content",
	parameters: Type.Object({ path: Type.String(), content: Type.String() }),
	execute: async (args) => {
		files.set(args.path, args.content);
		return { output: [{ type: "text", text: `wrote ${args.path}` }] };
	},
});

// A durable task: it runs once the run answered, and the run ends after it. A crash resumes it.
const RunTests = defineTask<{ attempt: number }, { phase: "run" }, boolean>({
	name: "app.run-tests",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (task, runtime, ctx) => {
			const result = runTests();
			console.log(`  [tests, attempt ${task.input.attempt}] ${result.output}`);
			// The handle is fetched before the commit: inside it, runtime reads would wait for the commit itself.
			const conversation = (await runtime.conversation(runtime.conversationId, ctx))!;
			await runtime.commit(async (tx) => {
				// Admitted with this commit, before its own table writes: placed when the run ends.
				if (!result.passed && task.input.attempt < 3) {
					await conversation.submit(tx, {
						type: "input",
						content: `The tests failed: ${result.output}. Fix it.`,
						whenBusy: "followUp",
						requestId: `fix-${task.input.attempt}`,
					});
				}
				await tx.appendEntry(runtime.conversationId, { kind: "app.tests", data: result });
				return { status: "terminal", outcome: { status: "completed", result: result.passed } };
			}, ctx);
		},
	},
	abort: async (_task, runtime, ctx) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }) as const, ctx),
});

let attempts = 0;
const TestsAfterEdits = defineExtension({
	name: "tests-after-edits",
	tools: [edit],
	tasks: [RunTests],
	hooks: [
		hook(GenerationTask, {
			afterRun: async (run, api, ctx) => {
				// The run's own entries, from its first input to its answer; a compaction never removes them.
				const range = { minEntryId: run.first, maxEntryId: run.last, order: "ascending" } as const;
				const { items } = await api.entries(range, 1000, undefined, ctx);
				const edited = items.some((entry) => {
					const message = entry.model?.[0];
					return ToolResultEntry.is(entry) && message?.role === "toolResult" && message.toolName === "edit";
				});
				// Each fix run asks again with a fresh turn budget: the extension caps the loop itself.
				return edited ? { tasks: [runEndTask(RunTests, { attempt: ++attempts })] } : undefined;
			},
		}),
	],
});

// ─── Host setup ─────────────────────────────────────────────────────────────

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
	// The first run edits, wrongly.
	fauxAssistantMessage(fauxToolCall("edit", { path: "math.ts", content: "export const add = (a, b) => a - b + 0;" }), {
		stopReason: "toolUse",
	}),
	fauxAssistantMessage("I cleaned up add."),
	// The user's question, queued first, runs first; it edits nothing, so no tests run after it.
	fauxAssistantMessage("Not yet: add subtracts. The fix is queued next."),
	// The fix run the failed tests started.
	fauxAssistantMessage(fauxToolCall("edit", { path: "math.ts", content: "export const add = (a, b) => a + b;" }), {
		stopReason: "toolUse",
	}),
	fauxAssistantMessage("Fixed: add adds now."),
]);

const registry = createRegistry();
registry.install(TestsAfterEdits);
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });

const submission = await root.submit({ type: "input", content: "Clean up math.ts." }, context);
// Resolves with the answer; the conversation stays busy while the tests run.
console.log("answered:", (await submission.wait(context)).status);
const live = await harness.snapshot(LiveDoc, root.id, context);
console.log("busy with after-run tasks:", live?.run?.afterRun !== undefined);
// Sent while the tests run: it waits for them. Follow-ups run in queue order, so it runs before the fix run.
await root.submit({ type: "input", content: "Are the tests green now?" }, context);

await root.waitForIdle(context);
const page = await root.entries({ order: "ascending" }, 100, undefined, context);
for (const entry of page.items) {
	const message = entry.model?.[0];
	if (entry.kind === "app.tests") console.log("tests:", (entry.data as { output: string }).output);
	else if (message?.role === "user") console.log(">", message.content);
	else if (message?.role === "assistant") {
		const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
		if (text !== "") console.log("agent:", text);
	}
}
await harness.close(context);
