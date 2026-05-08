// Hinweis-Renderer für interne System-Notifications (z.B. Datenschutz-Hinweis,
// "Dokument wird geparst…"). Aus packages/web-ui/example/src/custom-messages.ts
// übernommen, deutsche Texte.

import type { Message } from "@earendil-works/pi-ai";
import type { AgentMessage, MessageRenderer } from "@earendil-works/pi-web-ui";
import { defaultConvertToLlm, registerMessageRenderer } from "@earendil-works/pi-web-ui";
import { Alert } from "@mariozechner/mini-lit/dist/Alert.js";
import { html } from "lit";

export interface SystemNotificationMessage {
	role: "system-notification";
	message: string;
	variant: "default" | "destructive";
	timestamp: string;
}

declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		"system-notification": SystemNotificationMessage;
	}
}

const systemNotificationRenderer: MessageRenderer<SystemNotificationMessage> = {
	render: (message: SystemNotificationMessage) => {
		return html`
			<div class="px-4 py-2">
				${Alert({
					variant: message.variant,
					children: html`<div class="text-sm">${message.message}</div>`,
				})}
			</div>
		`;
	},
};

export function registerCustomMessageRenderers() {
	registerMessageRenderer("system-notification", systemNotificationRenderer);
}

// Custom messages werden NICHT an das LLM geschickt — sie sind UI-only.
export function customConvertToLlm(messages: AgentMessage[]): Message[] {
	const filtered = messages.filter((m) => (m as { role?: string }).role !== "system-notification");
	return defaultConvertToLlm(filtered);
}

export function createSystemNotification(
	message: string,
	variant: "default" | "destructive" = "default",
): SystemNotificationMessage {
	return {
		role: "system-notification",
		message,
		variant,
		timestamp: new Date().toISOString(),
	};
}
