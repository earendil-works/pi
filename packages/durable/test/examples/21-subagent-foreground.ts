// A foreground subagent tool: the parent's tool call creates a child conversation it owns, runs one task there, and
// returns the child's answer. Aborting the tool call aborts the child. A UI finds the child through the tool's running
// details and shows its view under the call.
// Uses OpenAI when OPENAI_API_KEY is set, and a scripted faux model otherwise.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/21-subagent-foreground.ts
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AssistantMessage, type FauxResponseStep, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
	AssistantEntry,
	type ConversationId,
	configure,
	createRegistry,
	defineExtension,
	defineTool,
	type EntryId,
	type EntryRecord,
	type Extension,
	Harness,
	type LiveState,
	MemoryStorage,
	type ToolExecutionApi,
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
				return { output: [{ type: "text", text }], details: { conversationId: child } };
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

// ─── UI: the parent's transcript, with each subagent's indented under its call ───

/** Print an assistant entry's text and tool calls. */
const print = (indent: string, entry: EntryRecord): void => {
	const message = entry.model?.[0];
	if (entry.kind !== "pi.assistant" || message?.role !== "assistant") return;
	for (const block of (message as AssistantMessage).content) {
		if (block.type === "text" && block.text !== "") console.log(`${indent}assistant: ${block.text}`);
		if (block.type === "toolCall") console.log(`${indent}tool ${block.name}(${JSON.stringify(block.arguments)})`);
	}
};
const attached = new Set<ConversationId>();
const attach = async (id: ConversationId, indent: string): Promise<void> => {
	attached.add(id);
	const watch = await (await harness.conversation(id, context))!.watch(context);
	let newest = watch.value.entries.at(-1)?.id ?? 0;
	watch.start(async (call) => {
		if (call.kind !== "value") return;
		const { value } = call;
		for (const entry of value.entries) if (entry.id > newest) print(indent, entry);
		newest = value.entries.at(-1)?.id ?? newest;
		// A running subagent call names its child conversation in its details.
		for (const slot of (value.docs["pi.live"] as LiveState).tools ?? []) {
			const child = (slot.details as { conversationId?: ConversationId } | undefined)?.conversationId;
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
// Watch callbacks run after their commit; let the last ones print.
await new Promise((resolve) => setTimeout(resolve, 0));
await harness.close(context);
