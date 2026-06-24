#!/usr/bin/env node
/**
 * Live probe for OpenAI Codex Responses websocket-cached mode.
 *
 * Runs a simple tool loop directly against the pi-ai provider source so it does not
 * depend on built dist packages or coding-agent SDK wiring.
 */

import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import {
	closeOpenAICodexWebSocketSessions,
	getOpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
	stream as streamOpenAICodexResponses,
} from "../src/api/openai-codex-responses.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Context, Message, Model, Tool, ToolResultMessage, Transport } from "../src/types.ts";

type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

interface Args {
	turns: number;
	transport: Transport;
	maxTokens: number;
	reasoning: ThinkingLevel;
	sessionId: string;
}

const DEFAULT_TURNS = 20;
const DEFAULT_MAX_TOKENS = 64;

function parseArgs(argv: string[]): Args {
	let turns = DEFAULT_TURNS;
	let transport: Transport = "websocket-cached";
	let maxTokens = DEFAULT_MAX_TOKENS;
	let reasoning: ThinkingLevel = "low";
	let sessionId = `pi-ai-codex-ws-cached-probe-${Date.now()}`;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--turns":
				turns = Number.parseInt(required(argv[++i], arg), 10);
				break;
			case "--transport": {
				const value = required(argv[++i], arg);
				if (value !== "sse" && value !== "websocket" && value !== "websocket-cached" && value !== "auto") {
					throw new Error(`Invalid --transport: ${value}`);
				}
				transport = value;
				break;
			}
			case "--max-tokens":
				maxTokens = Number.parseInt(required(argv[++i], arg), 10);
				break;
			case "--reasoning": {
				const value = required(argv[++i], arg);
				if (value !== "minimal" && value !== "low" && value !== "medium" && value !== "high" && value !== "xhigh") {
					throw new Error(`Invalid --reasoning: ${value}`);
				}
				reasoning = value;
				break;
			}
			case "--session-id":
				sessionId = required(argv[++i], arg);
				break;
			case "--help":
				printHelp();
				process.exit(0);
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return { turns, transport, maxTokens, reasoning, sessionId };
}

function required(value: string | undefined, flag: string): string {
	if (!value) throw new Error(`Missing value for ${flag}`);
	return value;
}

function printHelp(): void {
	console.log(`Usage: node test/codex-websocket-cached-probe.ts [options]

Options:
  --turns <n>          Number of user turns. Default: ${DEFAULT_TURNS}
  --transport <mode>   sse | websocket | websocket-cached | auto. Default: websocket-cached
  --reasoning <level>  minimal | low | medium | high | xhigh. Default: low
  --max-tokens <n>     Max output tokens per model request. Default: ${DEFAULT_MAX_TOKENS}
  --session-id <id>    Session id for websocket/cache state
`);
}

function buildPrompt(turn: number): string {
	const marker = `TURN-${String(turn).padStart(2, "0")}-MARKER-${(turn * 17 + 13) % 97}`;
	const lines = [
		"This is an automated OpenAI Codex Responses websocket cache probe.",
		`Task for turn ${turn}: call deterministic_probe exactly once before your final answer.`,
		`Use tool arguments: turn=${turn}, marker=${marker}`,
		`After the tool result arrives, reply exactly: TURN ${turn} OK ${marker}`,
		"The following repeated block is intentional benchmark padding.",
	];
	for (let i = 1; i <= 180; i++) {
		lines.push(
			`Turn ${turn} synthetic record ${String(i).padStart(3, "0")}: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega.`,
		);
	}
	return lines.join("\n");
}

function deterministicProbeTool(): Tool {
	return {
		name: "deterministic_probe",
		description: "Mandatory benchmark tool. Call exactly once with the turn and marker from the user prompt.",
		parameters: Type.Object({
			turn: Type.Number(),
			marker: Type.String(),
		}),
	};
}

function executeTool(call: Extract<AssistantMessage["content"][number], { type: "toolCall" }>): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text: `deterministic_probe_result ${JSON.stringify(call.arguments)} fixed=OK` }],
		details: { fixed: "OK" },
		isError: false,
		timestamp: Date.now(),
	};
}

function textOf(message: AssistantMessage): string {
	return message.content
		.filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function average(values: number[]): number {
	return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const model = getModel("openai-codex", "gpt-5.5") as Model<"openai-codex-responses"> | undefined;
	if (!model) throw new Error("Model openai-codex/gpt-5.5 not found");
	const modelWithMaxTokens = { ...model, maxTokens: args.maxTokens };
	const authStorage = AuthStorage.create();
	const apiKey = (await authStorage.getApiKey("openai-codex")) ?? (await authStorage.getApiKey("openai"));
	if (!apiKey) {
		throw new Error("No OpenAI Codex API key found in coding-agent auth storage.");
	}
	const context: Context = {
		systemPrompt:
			"You are participating in a benchmark. For each benchmark turn, call deterministic_probe exactly once before the final answer. Keep final answers minimal.",
		messages: [],
		tools: [deterministicProbeTool()],
	};
	const elapsed: number[] = [];
	resetOpenAICodexWebSocketDebugStats(args.sessionId);

	console.log(`provider openai-codex, model gpt-5.5`);
	console.log(`sessionId ${args.sessionId}`);
	console.log(
		`turns ${args.turns}, transport ${args.transport}, reasoning ${args.reasoning}, maxTokens ${args.maxTokens}`,
	);
	console.log(`scratch ${resolve(join(tmpdir(), args.sessionId))}`);
	console.log("");

	for (let turn = 1; turn <= args.turns; turn++) {
		context.messages.push({ role: "user", content: buildPrompt(turn), timestamp: Date.now() });
		const beforeStats = getOpenAICodexWebSocketDebugStats(args.sessionId);
		const started = Date.now();
		let requests = 0;
		let assistantCount = 0;
		let toolResults = 0;
		let finalText = "";
		let turnInput = 0;
		let turnOutput = 0;
		let turnCacheRead = 0;
		let turnCacheWrite = 0;

		while (true) {
			requests++;
			const message = await streamOpenAICodexResponses(modelWithMaxTokens, context, {
				apiKey,
				sessionId: args.sessionId,
				transport: args.transport,
				reasoningEffort: args.reasoning,
				maxTokens: args.maxTokens,
			}).result();
			assistantCount++;
			context.messages.push(message);
			turnInput += message.usage.input;
			turnOutput += message.usage.output;
			turnCacheRead += message.usage.cacheRead;
			turnCacheWrite += message.usage.cacheWrite;
			const toolCalls = message.content.filter(
				(block): block is Extract<AssistantMessage["content"][number], { type: "toolCall" }> =>
					block.type === "toolCall",
			);
			console.log(
				[
					`turn ${String(turn).padStart(2, "0")}.${requests}`,
					`stop ${message.stopReason}`,
					`in ${message.usage.input}`,
					`out ${message.usage.output}`,
					`cache ${message.usage.cacheRead}/${message.usage.cacheWrite}`,
					`tools ${toolCalls.length}`,
				].join(" | "),
			);
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				throw new Error(message.errorMessage ?? `request failed on turn ${turn}.${requests}`);
			}
			if (toolCalls.length === 0) {
				finalText = textOf(message);
				break;
			}
			for (const call of toolCalls) {
				context.messages.push(executeTool(call) as Message);
				toolResults++;
			}
			if (requests > 4) throw new Error(`Too many requests for turn ${turn}`);
		}

		const elapsedMs = Date.now() - started;
		elapsed.push(elapsedMs);
		const afterStats = getOpenAICodexWebSocketDebugStats(args.sessionId);
		const statLine = afterStats
			? `ws requests ${afterStats.requests - (beforeStats?.requests ?? 0)} | new/reused ${afterStats.connectionsCreated - (beforeStats?.connectionsCreated ?? 0)}/${afterStats.connectionsReused - (beforeStats?.connectionsReused ?? 0)} | cached ${afterStats.cachedContextRequests - (beforeStats?.cachedContextRequests ?? 0)} | store ${afterStats.storeTrueRequests - (beforeStats?.storeTrueRequests ?? 0)} | full/delta ${afterStats.fullContextRequests - (beforeStats?.fullContextRequests ?? 0)}/${afterStats.deltaRequests - (beforeStats?.deltaRequests ?? 0)}`
			: "ws none";
		console.log(
			[
				`turn ${String(turn).padStart(2, "0")} agg`,
				`elapsed ${(elapsedMs / 1000).toFixed(1)}s`,
				`assistant ${assistantCount}`,
				`toolResults ${toolResults}`,
				`in ${turnInput}`,
				`out ${turnOutput}`,
				`cache ${turnCacheRead}/${turnCacheWrite}`,
				statLine,
				`final ${JSON.stringify(finalText).slice(0, 80)}`,
			].join(" | "),
		);
	}

	const stats = getOpenAICodexWebSocketDebugStats(args.sessionId);
	console.log("");
	console.log(
		[
			"timing",
			`turns ${elapsed.length}`,
			`total ${(elapsed.reduce((sum, value) => sum + value, 0) / 1000).toFixed(1)}s`,
			`avg ${(average(elapsed) / 1000).toFixed(2)}s`,
			`p50 ${(percentile(elapsed, 50) / 1000).toFixed(2)}s`,
			`p95 ${(percentile(elapsed, 95) / 1000).toFixed(2)}s`,
			`max ${(Math.max(...elapsed) / 1000).toFixed(2)}s`,
		].join(" | "),
	);
	console.log(
		[
			"transport summary",
			`requested ${args.transport}`,
			`observed ${stats && stats.requests > 0 ? "websocket" : "sse/no-websocket"}`,
			`storeTrue ${stats ? `${stats.storeTrueRequests}/${stats.requests}` : "0/0"}`,
			`full/delta ${stats ? `${stats.fullContextRequests}/${stats.deltaRequests}` : "0/0"}`,
			`connections created/reused ${stats ? `${stats.connectionsCreated}/${stats.connectionsReused}` : "0/0"}`,
			`lastPreviousResponseId ${stats?.lastPreviousResponseId ?? "n/a"}`,
		].join(" | "),
	);
	closeOpenAICodexWebSocketSessions(args.sessionId);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
