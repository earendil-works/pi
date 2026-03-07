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
				case "toolCall":
					return [`${content.name} ${JSON.stringify(content.arguments)}`];
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
	const tps = formatTps(elapsedMs, estimatedOutputTokens);
	return `Working (${elapsed} • ${tps} tps • esc to interrupt)`;
}

export function formatDoneStatus(elapsedMs: number, estimatedOutputTokens: number): string {
	const elapsed = formatElapsed(elapsedMs);
	const tps = formatTps(elapsedMs, estimatedOutputTokens);
	return `Done after ${elapsed} - ${tps} tps`;
}

function formatTps(elapsedMs: number, estimatedOutputTokens: number): number {
	const elapsedSeconds = Math.max(1, Math.floor(elapsedMs / 1000));
	return Math.round(estimatedOutputTokens / elapsedSeconds);
}
