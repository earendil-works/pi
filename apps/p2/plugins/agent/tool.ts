// One-shot subagents for code mode scripts. `await tools.agent({ prompt, schema })` runs a fresh conversation and
// resolves to its final answer, parsed as JSON and validated against `schema`. Nothing is reported to the main
// conversation: only the script's return value reaches it.

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
	AssistantEntry,
	type ConversationId,
	configure,
	defineDoc,
	defineExtension,
	type Extension,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { arr, compile, obj, opt, str, unknown, type Validator } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import type { JsonValue } from "@p2/app/v1";
import { record, SUBAGENT_TASK_ENTRY } from "@p2/app/v1";
import { defineP2Tool, isTopLevel, type P2Tool } from "@p2/app/v1/worker";
import { InheritedLocation, resolveChoice, Subagents } from "../subagents/contract.worker.ts";
import { ownLocation } from "../subagents/tools.ts";

export const AGENT_TOOL = "agent";
const ATTEMPTS = 3;

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The call's conversation, created once, so a rerun after a restart reattaches to it and its submissions. */
const AgentRun = defineDoc<{ conversationId?: ConversationId }>({
	kind: "p2.agent-run",
	version: 1,
	scope: "task",
	initial: () => ({}),
	checkpointWhen: () => true,
});

/** `access` gives the worker's tools by name, with what they declare (`P2Tool`): which ones the agent may get. */
export function createAgentExtension(models: Models, access: () => ReadonlyMap<string, P2Tool>): Extension<P2Tool> {
	const tool = defineP2Tool({
		name: AGENT_TOOL,
		description:
			"Run a one-shot subagent in your cwd and resolve to its final answer, parsed as JSON and validated against `schema` (a JSON Schema object). Rejects when the subagent fails, or when its answer still does not validate after 3 attempts. Its answer is not reported to you, only what the script returns. Run many at once with `Promise.all`.",
		parameters: obj(
			{
				prompt: str({ description: "The task." }),
				label: opt(
					str({ description: "Short name shown where the user inspects it; default: the prompt's start." }),
				),
				schema: record(unknown(), { description: "JSON Schema of the answer." }),
				model: opt(str({ description: "'provider/modelId'; default: the caller's." })),
				thinkingLevel: opt(str({ description: "off|minimal|low|medium|high|xhigh|max; default: the caller's." })),
				tools: opt(
					arr(str(), {
						description:
							"Names of tools of yours it gets (default: all you can give); not those that work only in your conversation.",
					}),
				),
			},
			{ open: true },
		),
		structuredOutputSchema: unknown(),
		// Only scripts call it: a model would block its turn on it.
		callers: ["tools"],
		// A rerun reattaches to the call's conversation; submissions are deduplicated by request ID.
		replay: "safe",
		execute: async (args, api, context) => {
			const fail = (text: string) => ({ output: [{ type: "text" as const, text }], isError: true });
			let validator: Validator;
			try {
				// Formats are checked, as TypeBox's compiler did before the switch to pi-schema.
				validator = compile(args.schema, { formats });
			} catch (error) {
				return fail(`Invalid schema: ${errorMessage(error)}`);
			}
			// A rerun reattaches to the conversation it created, even if its model has since left the configuration.
			const existing = (await api.snapshot(AgentRun, api.taskId, context))?.conversationId;
			const choice =
				existing === undefined
					? await resolveChoice(models, api, access(), args, undefined, "one-shot", context)
					: undefined;
			if (typeof choice === "string") return fail(choice);
			// Owned by this call: aborting the call aborts the agent's work. Listed in the same commit, by the call ID the
			// script's tool card shows it under, so the user can open its transcript.
			// The main conversation's and its `/tree` branches' one-shot agents are listed in the session's registry.
			const listedOn = (await isTopLevel(api, api.conversationId, context))
				? ROOT_CONVERSATION_ID
				: api.conversationId;
			// The agent works where its caller does: a caller with its own location (a subagent's) passes it on.
			const inherited = await ownLocation(api, api.conversationId, context);
			const conversationId = await api.commit(async (tx) => {
				const run = await tx.doc(AgentRun, api.taskId);
				if (run.conversationId === undefined) {
					if (!choice) throw new Error("The agent's conversation record disappeared");
					const child = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					await configure(tx, child.id, {
						model: choice.model,
						thinkingLevel: choice.thinkingLevel,
						tools: choice.tools,
						modelTools: { add: choice.loaded },
						instructions: `You are a one-shot subagent working for a script. Do the requested work. Your final answer is parsed by the script: it must be only a JSON value matching this JSON Schema, without prose or code fences:\n${JSON.stringify(args.schema)}`,
					});
					if (inherited) {
						(await tx.doc(InheritedLocation, child.id)).location = inherited;
						await configure(tx, child.id, { cwd: inherited.cwd });
					}
					run.conversationId = child.id;
					const registry = await tx.doc(Subagents, listedOn);
					registry.oneShots ??= {};
					registry.oneShots[api.callId] = {
						conversationId: child.id,
						label: (args.label ?? args.prompt).replace(/\s+/g, " ").trim().slice(0, 80),
						model: `${choice.model.provider}/${choice.model.modelId}`,
						thinkingLevel: choice.thinkingLevel,
						tools: choice.chosen,
					};
				}
				return run.conversationId;
			}, context);
			const child = await api.conversation(conversationId, context);
			if (!child) return fail("The agent's conversation is gone.");
			let message = args.prompt;
			let problem = "";
			for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
				const submission = await child.submit(
					{
						type: "input",
						content: message,
						entry: { kind: SUBAGENT_TASK_ENTRY, data: {} },
						whenBusy: "followUp",
						requestId: `agent:${attempt}`,
					},
					context,
				);
				const settled = await submission.wait(context);
				if (settled.type !== "input" || settled.status !== "done")
					return fail(`The agent did not answer: ${settled.reason ?? settled.status}`);
				const answer = await api.commit(
					async (tx) =>
						(await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as AssistantMessage | undefined,
					context,
				);
				const text = (answer?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
				const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/.exec(text);
				let value: JsonValue;
				try {
					value = JSON.parse(fenced?.[1] ?? text) as JsonValue;
				} catch (error) {
					problem = `it is not JSON (${errorMessage(error)})`;
					message = `Your answer was not usable: ${problem}. Reply with only the JSON value.`;
					continue;
				}
				if (validator.check(value))
					return {
						output: [{ type: "text" as const, text: JSON.stringify(value) }],
						structuredOutput: value,
						details: { conversationId, attempts: attempt },
					};
				const errors = validator
					.errors(value)
					.slice(0, 5)
					.map((error) => `${error.path || "/"}: ${error.message}`);
				problem = `it does not match the schema (${errors.join("; ")})`;
				message = `Your answer was not usable: ${problem}. Reply with only the corrected JSON value.`;
			}
			return fail(`The agent's answer was not usable after ${ATTEMPTS} attempts: ${problem}.`);
		},
	});
	return defineExtension<P2Tool>({
		name: "p2-agent",
		tools: [tool],
	});
}
