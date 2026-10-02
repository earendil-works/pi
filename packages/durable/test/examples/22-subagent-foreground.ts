// A foreground subagent tool: the parent's tool call creates a child conversation it owns, runs one task there, and
// returns the child's answer. Aborting the tool call aborts the child. A UI finds the child through the tool's running
// details and shows its events under the call.
// Uses OpenAI when OPENAI_API_KEY is set, and a scripted faux model otherwise.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/22-subagent-foreground.ts
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AssistantMessage, type FauxResponseStep, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
	type AgentEvent,
	AssistantEntry,
	type ConversationId,
	configure,
	createRegistry,
	defineExtension,
	defineTool,
	type EntryId,
	type Extension,
	Harness,
	MemoryStorage,
	type ToolExecutionApi,
	watchEvents,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// ─── Product code: the subagent extension ───────────────────────────────────

async function answerText(api: ToolExecutionApi, answer: EntryId, callContext: Context): Promise<string> {
	const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), callContext);
	const message = entry?.model?.[0] as AssistantMessage;
	return message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
}

const Subagent: Extension = defineExtension({
	name: "subagent",
	tools: [
		defineTool({
			name: "subagent",
			description: "Delegate a self-contained task to a subagent and get its answer back.",
			parameters: Type.Object({ task: Type.String({ description: "What the subagent should do" }) }),
			// Safe to rerun after a crash: a rerun finds the child it already created and the submission it already made.
			replay: "safe",
			execute: async (args, api, callContext) => {
				const { task } = args;
				// The child is owned by this tool call's task, so aborting the call aborts the child, and the call
				// finishes only once the child's work is done.
				const child = await api.commit(async (tx) => {
					// Ownership records the child: a rerun of this call finds it instead of creating another.
					const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					if (existing !== undefined) return existing.id;
					// Starts as a copy of this conversation's agent: model, thinking level, cwd, extensions, tools.
					const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					// Without this extension, the child is not offered this tool.
					await configure(tx, created.id, { extensions: { remove: [Subagent] } });
					return created.id;
				}, callContext);
				// A UI watching the parent sees this and can attach to the child.
				await api.details({ conversationId: child }, callContext);

				const handle = (await api.conversation(child, callContext))!;
				// The request ID makes a rerun get back the submission it made before the crash.
				const request = { type: "input", content: task, requestId: `subagent:${api.taskId}` } as const;
				const settled = await (await handle.submit(request, callContext)).wait(callContext);
				if (settled.status !== "done" || settled.type !== "input") {
					throw new Error(`Subagent failed: ${settled.status}`);
				}
				const text = await answerText(api, settled.answer, callContext);
				return { content: [{ type: "text", text }], details: { conversationId: child } };
			},
		}),
	],
});

// ─── Host setup ─────────────────────────────────────────────────────────────

const models = createModels();
let model = { provider: "openai", modelId: "gpt-6-sol" };
if (process.env.OPENAI_API_KEY !== undefined) {
	models.setProvider(openaiProvider());
} else {
	// The parent delegates, the child answers, and the parent reports.
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	model = { provider: "faux", modelId: "faux-1" };
	const delegate = fauxToolCall("subagent", { task: "Name three prime numbers." }, { id: "call-1" });
	faux.setResponses([
		fauxAssistantMessage([delegate], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("2, 3, and 5.")]),
		fauxAssistantMessage([fauxText("The subagent says: 2, 3, and 5.")]),
	] satisfies FauxResponseStep[]);
}
const registry = createRegistry();
registry.install(Subagent);
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const root = await harness.root(context, { agent: { model } });

// ─── UI: the parent's events, with each subagent's events indented under its call ───

const print = (indent: string, event: AgentEvent): void => {
	if (event.type === "message_end" && event.entry.kind === "pi.assistant") {
		const message = event.entry.model?.[0] as AssistantMessage;
		const text = message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
		if (text !== "") console.log(`${indent}assistant: ${text}`);
	} else if (event.type === "tool_execution_start") {
		console.log(`${indent}tool ${event.toolName}(${JSON.stringify(event.args)})`);
	}
};
const attached = new Set<ConversationId>();
const attach = async (id: ConversationId, indent: string): Promise<void> => {
	attached.add(id);
	const stream = await watchEvents(harness, id, context);
	stream.start(async (events) => {
		for (const event of events) {
			print(indent, event);
			if (event.type !== "tool_execution_update") continue;
			const child = (event.details as { conversationId?: ConversationId } | undefined)?.conversationId;
			if (child !== undefined && !attached.has(child)) await attach(child, `${indent}  `);
		}
	});
};
await attach(root.id, "");

const submission = await root.submit(
	{ type: "input", content: "Use the subagent tool to find three prime numbers, then tell me what it said." },
	context,
);
await submission.wait(context);
await harness.waitForIdle(context);
// Event callbacks run after their commit; let the last ones print.
await new Promise((resolve) => setTimeout(resolve, 0));
await harness.close(context);
