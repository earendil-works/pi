// A subagent tool that parks until its child conversation answers, notified by the child's submission when it
// settles. The child itself parks on a person's answer, so while the person thinks, every task is parked and the
// Session needs no process.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/43-subagent-waits.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { obj, str } from "@earendil-works/pi-schema";
import {
	configure,
	createRegistry,
	defineExtension,
	defineSignal,
	defineTool,
	Harness,
	LiveDoc,
	MemoryStorage,
	SubmissionSettled,
	type TaskId,
	ToolResultEntry,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// The child's tool: it asks a person and parks until the answer comes.
const Answer = defineSignal({ name: "example.answer", version: 1, schema: obj({ text: str() }) });
const asked = new Map<TaskId, string>();
const askPerson = defineTool({
	name: "ask_person",
	description: "Ask the person a question and wait for the answer",
	parameters: obj({ question: str() }),
	replay: "safe",
	async execute({ question }, api, ctx) {
		const state = await api.readSignal(Answer, "answer", ctx);
		if (state !== undefined && "value" in state) return { output: [{ type: "text", text: state.value.text }] };
		asked.set(api.taskId, question);
		return { sleep: { signals: [Answer.key("answer")] } };
	},
});

// The parent's tool: delegate to a subagent and park until its submission settles.
export const Subagent = defineExtension({
	name: "subagent",
	tools: [
		defineTool({
			name: "subagent",
			description: "Delegate a task to a subagent and get its answer back",
			parameters: obj({ task: str() }),
			replay: "safe",
			async execute({ task }, api, ctx) {
				const state = await api.readSignal(SubmissionSettled, "answered", ctx);
				if (state !== undefined && "value" in state) {
					const settled = state.value;
					if (settled.status !== "done" || settled.type === "write")
						return { output: [{ type: "text", text: `Subagent ended: ${settled.status}` }], isError: true };
					// Any entry by ID, read in a commit without writes.
					const answer = await api.commit((tx) => tx.entry(settled.answer), ctx);
					const message = answer?.model?.[0] as AssistantMessage;
					return { output: message.content.filter((part) => part.type === "text") };
				}
				// The parent's own selection without this extension, computed before the commit.
				const extensions = (await api.agent(ctx)).extensions.filter(
					(extension) => extension.name !== Subagent.name,
				);
				const child = await api.commit(async (tx) => {
					const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					if (existing !== undefined) return existing.id;
					const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					await configure(tx, created.id, { extensions });
					return created.id;
				}, ctx);
				const handle = (await api.conversation(child, ctx))!;
				// The request ID makes a rerun find the same submission; `notify` signals this call when it settles.
				await handle.submit(
					{
						type: "input",
						content: task,
						requestId: `subagent:${api.taskId}`,
						notify: { taskId: api.taskId, key: "answered" },
					},
					ctx,
				);
				return { sleep: { signals: [SubmissionSettled.key("answered")] } };
			},
		}),
	],
});

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
	// Parent: delegate.
	fauxAssistantMessage(fauxToolCall("subagent", { task: "Find out whether we may deploy today" }), {
		stopReason: "toolUse",
	}),
	// Child: ask the person, then answer.
	fauxAssistantMessage(fauxToolCall("ask_person", { question: "May we deploy today?" }), { stopReason: "toolUse" }),
	fauxAssistantMessage("The person says yes, after 5 pm."),
	// Parent: final answer.
	fauxAssistantMessage("We may deploy today, after 5 pm."),
]);
const registry = createRegistry();
registry.install(defineExtension({ name: "people", tools: [askPerson] }));
registry.install(Subagent);
const harness = await Harness.open(new MemoryStorage(), { models, registry, onWake: () => {} }, context);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
const submission = await root.submit({ type: "input", content: "Can we deploy today?" }, context);

while (asked.size === 0) await new Promise((r) => setTimeout(r, 1));
await new Promise((r) => setTimeout(r, 5));
const parentSlot = (await harness.snapshot(LiveDoc, root.id, context))?.tools?.[0];
console.log("parent call:", parentSlot?.name, parentSlot?.status);
console.log("the person is asked:", [...asked.values()]);
console.log("wake while everything waits for the person:", harness.wake());

// The person answers through whatever showed the question; the host delivers it.
const [question] = asked.keys();
console.log("answer:", await harness.signal(question!, Answer, "answer", { text: "Yes, after 5 pm" }, context));
console.log("parent:", (await submission.wait(context)).status);
const page = await root.entries({}, 10, undefined, context);
const result = page.items.find((entry) => ToolResultEntry.is(entry))?.model?.[0] as ToolResultMessage;
console.log("subagent result:", result.content.map((part) => (part.type === "text" ? part.text : "")).join(""));
await harness.close(context);
