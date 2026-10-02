// A reviewer agent next to the main one: a cheaper model, a review role and loop, read-only tools, and its own
// checkout of the project.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/28-reviewer.ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import {
	AssistantEntry,
	createRegistry,
	defineExtension,
	GenerationTask,
	Harness,
	hook,
	MemoryStorage,
	section,
} from "../../src/index.ts";
import { CodingTools, createReadTool } from "../../src/tools/index.ts";

const context = BACKGROUND_CONTEXT;
const textOf = (message: AssistantMessage) =>
	message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

// ─── Product code: the reviewer extension ───────────────────────────────────

const DONE = "No further findings.";
// A role and a review loop: every answer that still has findings gets a second pass.
const Reviewer = defineExtension({
	name: "reviewer",
	sections: [section("role", () => `You review diffs. Report problems as a list. Never edit files.`)],
	hooks: [
		hook(GenerationTask, {
			onYield: (answer) =>
				textOf(answer).includes(DONE)
					? undefined
					: { continue: `Look again for anything you missed. Say "${DONE}" when there is nothing left.` },
		}),
	],
});

// ─── Host setup ─────────────────────────────────────────────────────────────

// The reviewer works in its own checkout, in practice a `git worktree add`.
const worktree = await mkdtemp(join(tmpdir(), "pi-durable-review-"));
await writeFile(join(worktree, "user.ts"), "export const name = (user) => user.name;\n");

const faux = fauxProvider({ models: [{ id: "big" }, { id: "small" }] });
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("read", { path: "user.ts" }), { stopReason: "toolUse" }),
	fauxAssistantMessage("1. `name` does not handle a missing user."),
	fauxAssistantMessage(`2. \`user\` has no type. ${DONE}`),
]);

const registry = createRegistry();
registry.install(CodingTools);
registry.install(Reviewer);
const harness = await Harness.open(
	new MemoryStorage(),
	// The main agent selects only CodingTools; the reviewer opts in.
	{
		models,
		registry,
		settings: { extensions: [CodingTools] },
		env: ({ cwd = process.cwd() }) => new NodeExecutionEnv({ cwd }),
	},
	context,
);
await harness.root(context, { agent: { model: { provider: "faux", modelId: "big" } } });

// Everything the reviewer is, stored on its conversation: the model, exactly these extensions in this order, only
// the read tool, and its directory. A restart keeps all of it.
const reviewer = await harness.createConversation(
	{
		ownership: { kind: "ownerless" },
		agent: {
			model: { provider: "faux", modelId: "small" },
			extensions: [CodingTools, Reviewer],
			tools: [createReadTool()],
			cwd: worktree,
		},
	},
	context,
);
const agent = await reviewer.agent(context);
console.log(
	"reviewer:",
	agent.model?.modelId,
	agent.extensions.map((extension) => extension.name),
	agent.tools.map((tool) => tool.name),
	agent.cwd === worktree,
);

await (await reviewer.submit({ type: "input", content: "Review user.ts." }, context)).wait(context);
const page = await reviewer.entries({}, 20, undefined, context);
for (const entry of [...page.items].reverse()) {
	const message = entry.model?.[0];
	if (message?.role === "user") console.log(">", message.content);
	if (AssistantEntry.is(entry) && textOf(message as AssistantMessage) !== "") {
		console.log("reviewer:", textOf(message as AssistantMessage));
	}
}

await harness.close(context);
await rm(worktree, { recursive: true, force: true });
