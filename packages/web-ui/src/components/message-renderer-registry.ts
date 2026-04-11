import type { AgentMessage } from "@tculpepp/spi-agent-core";
import type { TemplateResult } from "lit";

// Extract role type from AppMessage union
export type MessageRole = AgentMessage["role"];

// Generic message renderer typed to specific message type
export interface MessageRenderer<TMessage extends AgentMessage = AgentMessage> {
	render(message: TMessage): TemplateResult;
}

// Registry of custom message renderers by role
const messageRenderers = new Map<MessageRole, MessageRenderer<any>>();

export function registerMessageRenderer<TRole extends MessageRole>(
	role: TRole,
	renderer: MessageRenderer<Extract<AgentMessage, { role: TRole }>>,
): void {
	messageRenderers.set(role, renderer);
}

export function getMessageRenderer(role: MessageRole): MessageRenderer | undefined {
	return messageRenderers.get(role);
}

export function renderMessage(message: AgentMessage): TemplateResult | undefined {
	return messageRenderers.get(message.role)?.render(message);
}
