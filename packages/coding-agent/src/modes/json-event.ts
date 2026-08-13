import type { Usage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "../core/agent-session.ts";

type WithoutPartial<T> = T extends { partial: unknown } ? Omit<T, "partial"> : T;

type ToJsonEvent<T> = T extends {
	type: "message_update";
	assistantMessageEvent: infer TAssistantMessageEvent;
}
	? {
			type: "message_update";
			usage: Usage;
			assistantMessageEvent: WithoutPartial<TAssistantMessageEvent>;
		}
	: T;

/** Session event shape emitted by the JSON and RPC stdout protocols. */
export type JsonAgentSessionEvent = ToJsonEvent<AgentSessionEvent>;

type MessageUpdateEvent = Extract<AgentSessionEvent, { type: "message_update" }>;
type JsonMessageUpdateEvent = Extract<JsonAgentSessionEvent, { type: "message_update" }>;

/**
 * Remove cumulative assistant snapshots from streaming wire events.
 * `message_start` provides the initial message, deltas build it, and
 * `message_end` provides the final authoritative message. Cumulative usage
 * remains available because its size is constant.
 */
export function toJsonEvent(event: MessageUpdateEvent): JsonMessageUpdateEvent;
export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent;
export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent {
	if (event.type !== "message_update") {
		return event;
	}
	if (event.message.role !== "assistant") {
		throw new Error("message_update message is not an assistant message");
	}

	const assistantMessageEvent = event.assistantMessageEvent;
	if (!("partial" in assistantMessageEvent)) {
		return { type: "message_update", usage: event.message.usage, assistantMessageEvent };
	}

	const { partial: _partial, ...deltaEvent } = assistantMessageEvent;
	return { type: "message_update", usage: event.message.usage, assistantMessageEvent: deltaEvent };
}
