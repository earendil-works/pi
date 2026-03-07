import type { AssistantMessage } from "@kennyfrc/mu-ai";
import { estimateTokens } from "../tools/handoff.js";
import { formatElapsed } from "../utils/format-elapsed.js";

function collectVisibleAssistantText(message: AssistantMessage): string {
	return message.content
		.flatMap((content) => {
			switch (content.type) {
				case "text":
					return [content.text];
				case "thinking":
					return [content.thinking];
				default:
					return [];
			}
		})
		.join("\n\n");
}

export function estimateWorkingStatusTokens(message: AssistantMessage): number {
	return estimateTokens(collectVisibleAssistantText(message));
}

export function formatWorkingStatus(elapsedMs: number, estimatedOutputTokens: number): string {
	const elapsed = formatElapsed(elapsedMs);
	const elapsedSeconds = Math.max(1, Math.floor(elapsedMs / 1000));
	const tps = Math.round(estimatedOutputTokens / elapsedSeconds);
	return `Working (${elapsed} • ${tps} tps • esc to interrupt)`;
}
