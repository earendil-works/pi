// The faux login on a session's worker, for tests only: each `faux.login` thing gives a pi-ai faux provider answering
// from the thing's script (the first step whose `when` its request's last message contains; none: an error answer),
// and when one of them has `tool`, the tool `faux_session`, which reads the session's title from the server through the agent's `call`.
// Every request is recorded with the tools it offered (`FauxRequests`).

import { admitSession, arr, defineFacet, local, SessionFacts } from "@earendil-works/p3/v1";
import {
	type Agent,
	defineExtension,
	defineTool,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type Message,
	ThingExtensions,
	thingExtension,
} from "@earendil-works/p3/v1/worker";
import { FauxLogin, FauxRequest, FauxRequests, type Step } from "./contract.ts";

/** The worker's log of what every faux login received, and the logins' gift, which records into it. */
const Log = local("faux.log", { version: 1, params: {}, members: { requests: arr(FauxRequest) } });

export default defineFacet((host) => {
	host.serve(Log, (_params, self) => {
		const log = self.writable<readonly FauxRequest[]>([]);
		const record = (request: FauxRequest): void => log.set([...log.value, request]);
		self.contribute(
			ThingExtensions,
			thingExtension(FauxLogin, (things, agent) => ({
				providers: things.map(({ options }) => scripted(options.provider, options.script, record)),
				...(things.some(({ options }) => options.tool) ? { extension: sessionTool(agent) } : {}),
			})),
		);
		return { requests: self.derive([log], ([value]) => [...value]) };
	});
	host.serve(FauxRequests, (_params, _principal, _admitted, self) => ({ requests: self.get(Log, {}).requests }), {
		admit: admitSession(),
	});
});

/** A faux provider `provider` answering from `script`, recording each request. */
function scripted(provider: string, script: readonly Step[], recorded: (request: FauxRequest) => void) {
	const faux = fauxProvider({ provider, models: [{ id: `${provider}-model` }] });
	const answer = (context: { messages: Message[] }) => {
		const last = lastText(context.messages);
		const step = script.find(({ when }) => last.includes(when));
		recorded({ provider, last, tools: offered(context.messages), matched: step !== undefined });
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
	return faux.provider;
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

/** The tool `faux_session`: the session's title, read through the agent from the server's `SessionFacts`. */
function sessionTool(agent: Agent) {
	return defineExtension({
		name: "faux-session",
		tools: [
			defineTool({
				name: "faux_session",
				description: "The session's title",
				parameters: { type: "object", properties: {} },
				execute: async (_args, _api, context) => {
					const title = await agent.call(
						async (ctx) => (await ctx.get(SessionFacts, {})).session.value?.title ?? "",
						context,
					);
					return { output: [{ type: "text", text: `title: ${title}` }] };
				},
			}),
		],
	});
}
