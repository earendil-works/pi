// The faux provider on a session's worker, for tests only: pi-ai's faux provider answering from the script that is its
// API key (`keyOf`): each request answers with the first step whose `when` its last message contains (none: an error
// answer), the script read from the request's own auth.

import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type Message,
	type Provider,
} from "@earendil-works/p3/v1/worker";
import { fauxAuth } from "./auth.ts";
import { FAUX_MODEL, FAUX_NAME, FAUX_PROVIDER, type FauxRequest, type Step } from "./contract.ts";

/** The faux provider; each request it answers is told to `recorded`. */
export function scriptedProvider(recorded: (request: FauxRequest) => void): Provider {
	const faux = fauxProvider({ provider: FAUX_PROVIDER, api: "faux", models: [{ id: FAUX_MODEL }] });
	const answer = (context: { messages: Message[] }, options: { apiKey?: string } | undefined) => {
		const script = scriptOf(options?.apiKey);
		const last = lastText(context.messages);
		const step = script.find(({ when }) => last.includes(when));
		recorded({ provider: FAUX_PROVIDER, last, tools: offered(context.messages), matched: step !== undefined });
		// One answer queued at a time: each request queues the next.
		faux.appendResponses([answer]);
		if (step === undefined)
			return fauxAssistantMessage("", { stopReason: "error", errorMessage: `unscripted: ${last}` });
		const content = step.reply.map((part) =>
			part.kind === "text" ? fauxText(part.text) : fauxToolCall(part.name, JSON.parse(part.args)),
		);
		return fauxAssistantMessage(content, {
			stopReason: step.reply.some((part) => part.kind === "tool") ? "toolUse" : "stop",
		});
	};
	faux.setResponses([answer]);
	return { ...faux.provider, name: FAUX_NAME, auth: fauxAuth() };
}

/** The script of a request's API key (a faux login's credential); none or a broken one answers nothing. */
function scriptOf(key: string | undefined): readonly Step[] {
	try {
		return key === undefined ? [] : (JSON.parse(key) as Step[]);
	} catch {
		return [];
	}
}

/** The text of the last message that is not a system message (a change of tools): the user's, or a tool result's. */
function lastText(messages: readonly Message[]): string {
	const last = messages.findLast((message) => message.role !== "system");
	if (last === undefined || last.role === "assistant") return "";
	if (typeof last.content === "string") return last.content;
	return last.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** The tools the request offers: its system messages' additions minus their removals, in order. */
function offered(messages: readonly Message[]): string[] {
	const tools: string[] = [];
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const removed of message.toolsRemoved ?? []) tools.splice(tools.indexOf(removed.name), 1);
		for (const added of message.toolsAdded ?? []) tools.push(added.name);
	}
	return tools.toSorted();
}
