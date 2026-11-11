// Gates before a tool runs: an approvals extension parks a risky `bash` call until a person approves it, keyed by the
// arguments it saw, with a deadline fixed at its first pass. A second gate (quiet hours) is asked again on every wake,
// since the whole `call` phase runs again. Denial and expiry end the call as blocks.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/44-approval-gate.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { bool, obj, str } from "@earendil-works/pi-schema";
import {
	createRegistry,
	defineExtension,
	defineSignal,
	defineTool,
	Harness,
	hook,
	LiveDoc,
	MemoryStorage,
	type TaskId,
	ToolResultEntry,
	ToolTask,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;
const DAY = 24 * 60 * 60 * 1000;
let clock = Date.UTC(2026, 10, 9, 9);

const bash = defineTool({
	name: "bash",
	description: "Run a shell command",
	parameters: obj({ command: str() }),
	execute: async ({ command }) => ({ output: [{ type: "text", text: `ran: ${command}` }] }),
});

// ─── The approvals extension ──────────────────────────────────────────────────

const Approval = defineSignal({ name: "approvals.decision", version: 1, schema: obj({ allow: bool() }) });
const isRisky = (args: Record<string, unknown>) => String(args.command).startsWith("rm ");
// A digest of the arguments; other arguments, another question. (Sorting keys is left out: there is one argument.)
const canonicalDigest = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
// What shows the question keeps its own record, by task ID and key.
const questions = new Map<string, { taskId: TaskId; command: string }>();

export const Approvals = defineExtension({
	name: "approvals",
	hooks: [
		hook(ToolTask, {
			beforeTool: async (call, api, ctx) => {
				if (call.name !== "bash" || !isRisky(call.arguments)) return undefined;
				const key = canonicalDigest(call.arguments);
				const state = await api.readSignal(Approval, key, ctx);
				// One deadline per question, fixed at the first pass: later passes (wakes, registry changes) keep it.
				const until = await api.memo(`approvals.until.${key}`, api.now() + DAY, ctx);
				if (state === undefined) {
					questions.set(key, { taskId: api.taskId, command: String(call.arguments.command) });
					return { sleep: { signals: [Approval.key(key)], until } };
				}
				questions.delete(key);
				if ("expired" in state) return { block: "No approval within a day" };
				return state.value.allow ? undefined : { block: "Not approved" };
			},
		}),
	],
});

// A second gate, installed first: asked again on every wake, it reads the clock each time.
let quietChecks = 0;
export const QuietHours = defineExtension({
	name: "quiet-hours",
	hooks: [
		hook(ToolTask, {
			beforeTool: async (_call, api) => {
				quietChecks++;
				const hour = new Date(api.now()).getUTCHours();
				return hour >= 22 || hour < 6 ? { block: "Quiet hours: no commands at night" } : undefined;
			},
		}),
	],
});

// ─── Host ─────────────────────────────────────────────────────────────────────

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const command = (text: string) =>
	fauxAssistantMessage(fauxToolCall("bash", { command: text }), { stopReason: "toolUse" });
faux.setResponses([
	command("rm -rf build"),
	fauxAssistantMessage("Cleaned."),
	command("rm -rf dist"),
	fauxAssistantMessage("Not cleaned."),
	command("rm -rf cache"),
	fauxAssistantMessage("Nobody answered."),
]);
const registry = createRegistry();
for (const extension of [defineExtension({ name: "tools", tools: [bash] }), QuietHours, Approvals]) {
	registry.install(extension);
}
const harness = await Harness.open(
	new MemoryStorage(),
	{ models, registry, now: () => clock, onWake: () => {} },
	context,
);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });

const asked = async () => {
	while (questions.size === 0) await new Promise((r) => setTimeout(r, 1));
	await new Promise((r) => setTimeout(r, 5));
	const [[key, question]] = [...questions];
	return { key: key!, ...question! };
};
const lastResult = async () => {
	const page = await root.entries({}, 20, undefined, context);
	const result = page.items.find((entry) => ToolResultEntry.is(entry))?.model?.[0] as ToolResultMessage;
	return result.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("")
		.replaceAll("\n", " ");
};
const run = async (input: string, answer: (key: string, taskId: TaskId) => Promise<void>) => {
	quietChecks = 0;
	const submission = await root.submit({ type: "input", content: input }, context);
	const question = await asked();
	const slot = (await harness.snapshot(LiveDoc, root.id, context))?.tools?.[0];
	console.log(`asked to approve "${question.command}"; the call is ${slot?.status}; wake:`, harness.wake());
	await answer(question.key, question.taskId);
	await submission.wait(context);
	console.log(`  result: ${await lastResult()} (quiet-hours gate asked ${quietChecks} times)`);
};

// 1. Approved: the whole call phase runs again, both gates pass, and the command runs.
await run("Clean build", async (key, taskId) => {
	console.log("  approve:", await harness.signal(taskId, Approval, key, { allow: true }, context));
});
// 2. Denied: a block.
await run("Clean dist", async (key, taskId) => {
	console.log("  deny:", await harness.signal(taskId, Approval, key, { allow: false }, context));
});
// 3. Nobody answers within a day: the deadline wakes it, and the gate blocks.
await run("Clean cache", async () => {
	clock += DAY;
	harness.resume();
});
await harness.close(context);
