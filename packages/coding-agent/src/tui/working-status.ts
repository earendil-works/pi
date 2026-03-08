import type { AssistantMessage } from "@kennyfrc/mu-ai";
import { estimateTokens } from "../tools/handoff.js";
import { formatElapsed } from "../utils/format-elapsed.js";

function collectVisibleAssistantText(message: AssistantMessage): string {
	return message.content
		.flatMap((content) => {
			switch (content.type) {
				case "text":
					return [content.text];
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

export function formatWorkingStatus(
	elapsedMs: number,
	estimatedOutputTokens: number,
	averageLatencyMs?: number,
): string {
	const elapsed = formatElapsed(elapsedMs);
	const tps = formatTps(elapsedMs, estimatedOutputTokens);
	const avgLatency = formatAverageLatency(averageLatencyMs);
	return avgLatency === null
		? `Working (${elapsed} • ${tps} tps • esc to interrupt)`
		: `Working (${elapsed} • ${tps} tps • ${avgLatency} lat. • esc to interrupt)`;
}

export function formatDoneStatus(elapsedMs: number, estimatedOutputTokens: number, averageLatencyMs?: number): string {
	const elapsed = formatElapsed(elapsedMs);
	const tps = formatTps(elapsedMs, estimatedOutputTokens);
	const avgLatency = formatAverageLatency(averageLatencyMs);
	return avgLatency === null
		? `Done after ${elapsed} - ${tps} tps`
		: `Done after ${elapsed} - ${tps} tps - ${avgLatency} lat.`;
}

export function getWorkingStatusSpinnerFrame(nowMs: number): string {
	const frames = ["⣀", "⣠", "⣴", "⣾", "⣿", "⣷", "⣧", "⣇", "⡇"] as const;
	const frameDurationMs = 120;
	return frames[Math.floor(nowMs / frameDurationMs) % frames.length] ?? frames[0];
}

function formatTps(elapsedMs: number, estimatedOutputTokens: number): number {
	if (elapsedMs <= 0 || estimatedOutputTokens <= 0) {
		return 0;
	}
	return Math.round((estimatedOutputTokens * 1000) / elapsedMs);
}

function formatAverageLatency(averageLatencyMs: number | undefined): string | null {
	if (averageLatencyMs === undefined) {
		return null;
	}
	return `${(averageLatencyMs / 1000).toFixed(1)}s`;
}
