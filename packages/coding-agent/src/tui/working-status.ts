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
	tokensPerSecondElapsedMs: number = elapsedMs,
	ttftMs?: number,
): string {
	const elapsed = formatElapsed(elapsedMs);
	const tps = formatTps(tokensPerSecondElapsedMs, estimatedOutputTokens);
	const ttft = formatTtft(ttftMs);
	const avgLatency = formatAverageLatency(averageLatencyMs);
	const segments = [`${tps} tps`];
	if (ttft !== null) segments.push(`${ttft} ttft`);
	if (avgLatency !== null) segments.push(`${avgLatency} lat.`);
	return `Working (${elapsed} • ${segments.join(" • ")} • esc→stop)`;
}

export function formatDoneStatus(
	elapsedMs: number,
	estimatedOutputTokens: number,
	averageLatencyMs?: number,
	tokensPerSecondElapsedMs: number = elapsedMs,
	ttftMs?: number,
): string {
	const elapsed = formatElapsed(elapsedMs);
	const tps = formatTps(tokensPerSecondElapsedMs, estimatedOutputTokens);
	const ttft = formatTtft(ttftMs);
	const avgLatency = formatAverageLatency(averageLatencyMs);
	const segments = [`${tps} tps`];
	if (ttft !== null) segments.push(`${ttft} ttft`);
	if (avgLatency !== null) segments.push(`${avgLatency} lat.`);
	return `Done after ${elapsed} - ${segments.join(" - ")}`;
}

export function getWorkingStatusSpinnerFrame(nowMs: number): string {
	const frames = ["░▒▓█   ", " ░▒▓█  ", "  ░▒▓█ ", "   ░▒▓█", "   █▓▒░", "  █▓▒░ ", " █▓▒░  ", "█▓▒░   "] as const;
	const frameDurationMs = 120;
	return frames[Math.floor(nowMs / frameDurationMs) % frames.length] ?? frames[0];
}

function formatTps(elapsedMs: number, estimatedOutputTokens: number): number {
	if (elapsedMs <= 0 || estimatedOutputTokens <= 0) {
		return 0;
	}
	return Math.round((estimatedOutputTokens * 1000) / elapsedMs);
}

function formatTtft(ttftMs: number | undefined): string | null {
	if (ttftMs === undefined) {
		return null;
	}
	return `${(ttftMs / 1000).toFixed(1)}s`;
}

function formatAverageLatency(averageLatencyMs: number | undefined): string | null {
	if (averageLatencyMs === undefined) {
		return null;
	}
	return `${(averageLatencyMs / 1000).toFixed(1)}s`;
}
