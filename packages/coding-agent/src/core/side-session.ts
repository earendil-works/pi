// Temporary read-only conversations: no SessionManager, transcript file, or parent mutation.
import { randomUUID } from "node:crypto";
import { Agent } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "./extensions/types.ts";
import { convertToLlm } from "./messages.ts";
import { createReadOnlyTools } from "./tools/index.ts";

type SideSessionContext = Pick<
	ExtensionContext,
	"cwd" | "model" | "thinkingLevel" | "modelRegistry" | "sessionManager" | "getSystemPrompt"
>;

/** Create a fresh in-memory agent seeded from the main conversation and restricted to built-in read-only tools. */
export function createSideSession(ctx: SideSessionContext): Agent {
	if (!ctx.model) throw new Error("Select a model before opening /btw");
	const agent = new Agent({
		initialState: {
			systemPrompt: `${ctx.getSystemPrompt()}\n\nThis is a temporary, read-only side conversation. The inherited conversation is background context, not a request to continue its work. Answer only the new questions asked here. Only read, grep, find, and ls are available. Do not run commands, change files, manage jobs or Rex, or claim to have done so. This conversation is discarded when its view closes.`,
			model: ctx.model,
			thinkingLevel: ctx.thinkingLevel ?? "off",
			tools: createReadOnlyTools(ctx.cwd),
		},
		convertToLlm,
		streamFn: (model, context, options) => ctx.modelRegistry.streamSimple(model, context, options),
		sessionId: randomUUID(),
	});
	const history = ctx.sessionManager.buildSessionProjection().messages;
	const returned = new Set<string>();
	let end = history.length;
	for (let index = history.length - 1; index >= 0; index--) {
		const message = history[index];
		if (message.role === "toolResult") returned.add(message.toolCallId);
		if (message.role === "assistant") {
			// An in-flight main tool round is not a complete provider transcript. Do not invent its results.
			if (message.content.some((part) => part.type === "toolCall" && !returned.has(part.id))) end = index;
			break;
		}
	}
	// The final system boundary advertises only side-chat tools, not inherited writable declarations.
	agent.state.messages = [...(end === history.length ? history : history.slice(0, end)), ...agent.state.messages];
	return agent;
}
