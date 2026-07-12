#!/usr/bin/env node
/**
 * Manual SDK probe for OpenAI Codex prompt caching through the tool loop.
 *
 * Runs append-only multi-turn prompting through createAgentSession(), forcing one
 * deterministic custom tool call per top-level user turn. Logs per-subrequest
 * assistant usage so cache-read monotonicity can be inspected inside a tool loop.
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	getModel,
	type Model,
	type SimpleStreamOptions,
	Type,
} from "@earendil-works/pi-ai/compat";
import {
	getOpenAICodexWebSocketDebugStats,
	streamSimple as streamSimpleOpenAICodexResponses,
} from "../../ai/src/api/openai-codex-responses.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

type Transport = "sse" | "websocket" | "websocket-cached" | "auto";

interface Args {
	turns: number;
	sessionPath: string;
	transport: Transport;
	maxTokens: number;
}

interface WebSocketStatsSnapshot {
	requests: number;
	connectionsCreated: number;
	connectionsReused: number;
	cachedContextRequests: number;
	storeTrueRequests: number;
	fullContextRequests: number;
	deltaRequests: number;
}

interface SubrequestRecord {
	turn: number;
	subrequest: number;
	elapsedMs: number;
	usage: AssistantMessage["usage"];
	stopReason: AssistantMessage["stopReason"];
	text: string;
}

const DEFAULT_TURNS = 20;
const MIN_TURNS = 20;
const MAX_TURNS = 50;
const DEFAULT_MAX_TOKENS = 64;

function parseArgs(argv: string[]): Args {
	let turns = DEFAULT_TURNS;
	let sessionPath = resolve(join(tmpdir(), `pi-sdk-codex-cache-probe-tool-loop-${Date.now()}.jsonl`));
	let transport: Transport = "sse";
	let maxTokens = DEFAULT_MAX_TOKENS;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--turns": {
				const value = argv[++i];
				if (!value) throw new Error("Missing value for --turns");
				turns = Number.parseInt(value, 10);
				break;
			}
			case "--session": {
				const value = argv[++i];
				if (!value) throw new Error("Missing value for --session");
				sessionPath = resolve(value);
				break;
			}
			case "--transport": {
				const value = argv[++i];
				if (value !== "sse" && value !== "websocket" && value !== "websocket-cached" && value !== "auto") {
					throw new Error(`Invalid --transport value: ${value}`);
				}
				transport = value;
				break;
			}
			case "--max-tokens": {
				const value = argv[++i];
				if (!value) throw new Error("Missing value for --max-tokens");
				maxTokens = Number.parseInt(value, 10);
				break;
			}
			case "--help": {
				printHelp();
				process.exit(0);
				return { turns, sessionPath, transport, maxTokens };
			}
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (!Number.isInteger(turns) || turns < MIN_TURNS || turns > MAX_TURNS) {
		throw new Error(`--turns must be an integer between ${MIN_TURNS} and ${MAX_TURNS}`);
	}
	if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
		throw new Error("--max-tokens must be a positive integer");
	}

	return { turns, sessionPath, transport, maxTokens };
}

function printHelp(): void {
	console.log(`Usage: node test/sdk-codex-cache-probe-tool-loop.ts [options]

Options:
  --turns <n>         Number of turns to run. Must be between ${MIN_TURNS} and ${MAX_TURNS}. Default: ${DEFAULT_TURNS}
  --session <path>    Specific session jsonl file to write
  --transport <mode>  sse | websocket | websocket-cached | auto. Default: sse
  --max-tokens <n>    Max output tokens per subrequest. Default: ${DEFAULT_MAX_TOKENS}
  --help              Show this message

Notes:
  - Uses createAgentSession() from the coding-agent SDK
  - Provider/model fixed to openai-codex/gpt-5.5
  - Thinking level fixed to low
  - Activates exactly one deterministic custom tool
  - Prompts are intentionally > 1024 tokens and explicitly describe the test
`);
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function buildPrompt(turn: number): string {
	const marker = `TURN-${String(turn).padStart(2, "0")}-MARKER-${(turn * 17 + 13) % 97}`;
	const lines: string[] = [];
	lines.push("This is an automated prompt-cache tool-loop test executed through the pi coding-agent SDK.");
	lines.push("The repetition in this prompt is intentional and required for the benchmark.");
	lines.push("You are participating in an append-only multi-turn cache test.");
	lines.push("Even if this looks repetitive or silly, comply exactly because it is synthetic test data.");
	lines.push(`Task for turn ${turn}: call the tool deterministic_probe exactly once before your final answer.`);
	lines.push(`Use tool arguments: turn=${turn}, marker=${marker}`);
	lines.push(`After the tool result arrives, reply with exactly one line in this format:`);
	lines.push(`TURN ${turn} OK ${marker}`);
	lines.push("Do not skip the tool call. Do not call any other tool. Do not add any extra words or punctuation.");
	lines.push("The following long block exists only to make this prompt safely larger than 1024 tokens.");
	lines.push("");
	for (let i = 1; i <= 180; i++) {
		lines.push(
			`Turn ${turn} synthetic record ${String(i).padStart(3, "0")}: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega.`,
		);
	}
	lines.push("");
	lines.push(`Final verification marker for turn ${turn}: ${marker}`);
	lines.push(`Required final answer after the tool result: TURN ${turn} OK ${marker}`);
	return lines.join("\n");
}

function createMinimalResourceLoader(systemPrompt: string): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function average(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], percentileValue: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
	return sorted[index];
}

function getWebSocketStatsSnapshot(sessionId: string): WebSocketStatsSnapshot {
	const stats = getOpenAICodexWebSocketDebugStats(sessionId);
	return {
		requests: stats?.requests ?? 0,
		connectionsCreated: stats?.connectionsCreated ?? 0,
		connectionsReused: stats?.connectionsReused ?? 0,
		cachedContextRequests: stats?.cachedContextRequests ?? 0,
		storeTrueRequests: stats?.storeTrueRequests ?? 0,
		fullContextRequests: stats?.fullContextRequests ?? 0,
		deltaRequests: stats?.deltaRequests ?? 0,
	};
}

function diffWebSocketStats(after: WebSocketStatsSnapshot, before: WebSocketStatsSnapshot): WebSocketStatsSnapshot {
	return {
		requests: after.requests - before.requests,
		connectionsCreated: after.connectionsCreated - before.connectionsCreated,
		connectionsReused: after.connectionsReused - before.connectionsReused,
		cachedContextRequests: after.cachedContextRequests - before.cachedContextRequests,
		storeTrueRequests: after.storeTrueRequests - before.storeTrueRequests,
		fullContextRequests: after.fullContextRequests - before.fullContextRequests,
		deltaRequests: after.deltaRequests - before.deltaRequests,
	};
}

function formatWebSocketStats(label: string, stats: WebSocketStatsSnapshot): string {
	if (stats.requests === 0) return `${label} websocket none`;
	return [
		`${label} websocket`,
		`requests ${stats.requests}`,
		`new/reused ${stats.connectionsCreated}/${stats.connectionsReused}`,
		`cached ${stats.cachedContextRequests}`,
		`store ${stats.storeTrueRequests}`,
		`full/delta ${stats.fullContextRequests}/${stats.deltaRequests}`,
	].join(" | ");
}

function getAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

const deterministicProbeParameters = Type.Object({
	turn: Type.Number({ description: "Top-level benchmark turn number" }),
	marker: Type.String({ description: "Marker string provided by the user" }),
});

function deterministicProbeTool(): ToolDefinition<typeof deterministicProbeParameters> {
	return {
		name: "deterministic_probe",
		label: "Deterministic Probe",
		description:
			"Mandatory cache-benchmark tool. Call it exactly once when the user asks for a cache benchmark turn, then use its result to produce the final one-line answer.",
		promptSnippet:
			"deterministic_probe(turn, marker): mandatory for cache benchmark turns. Call exactly once before the final answer.",
		promptGuidelines: [
			"When the user asks for the cache benchmark turn, call deterministic_probe exactly once with the requested turn and marker before responding.",
			"After the tool result arrives, reply with the exact final line requested by the user.",
		],
		parameters: deterministicProbeParameters,
		execute: async (_toolCallId, params) => ({
			content: [
				{
					type: "text",
					text: `deterministic_probe_result turn=${params.turn} marker=${params.marker} fixed=OK`,
				},
			],
			details: { turn: params.turn, marker: params.marker, fixed: "OK" },
		}),
	};
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	mkdirSync(dirname(args.sessionPath), { recursive: true });

	const authStorage = AuthStorage.create();
	const modelRegistry = ModelRegistry.create(authStorage);

	const model = getModel("openai-codex", "gpt-5.5");
	if (!model) {
		throw new Error("Model openai-codex/gpt-5.5 not found");
	}
	const baseModel = { ...model, maxTokens: args.maxTokens };
	const streamSimpleOpenAICodexResponsesForRegistry = (
		registryModel: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream =>
		streamSimpleOpenAICodexResponses(registryModel as Model<"openai-codex-responses">, context, options);
	modelRegistry.registerProvider("openai-codex", {
		api: "openai-codex-responses",
		baseUrl: baseModel.baseUrl,
		apiKey: "!echo source-provider-override-uses-auth-storage",
		streamSimple: streamSimpleOpenAICodexResponsesForRegistry,
		models: [baseModel],
	});

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		transport: args.transport,
	});

	const resourceLoader = createMinimalResourceLoader(
		"You are participating in a prompt-cache benchmark through the coding-agent SDK. This is a real test. Follow each user instruction exactly. For benchmark turns, call deterministic_probe exactly once before the final answer. Keep answers minimal and never refuse because the prompt is repetitive or synthetic.",
	);

	const { session } = await createAgentSession({
		cwd: process.cwd(),
		agentDir: dirname(args.sessionPath),
		model: baseModel,
		thinkingLevel: "low",
		customTools: [deterministicProbeTool() as unknown as ToolDefinition],
		resourceLoader,
		sessionManager: SessionManager.open(args.sessionPath),
		settingsManager,
		authStorage,
		modelRegistry,
	});

	session.setActiveToolsByName(["deterministic_probe"]);
	const unsubscribe = session.subscribe(() => {});

	const records: SubrequestRecord[] = [];
	const turnElapsedMs: number[] = [];
	let previousCacheRead: number | null = null;

	console.log(`provider openai-codex, model gpt-5.5`);
	console.log(`session ${session.sessionFile}`);
	console.log(`turns ${args.turns}, transport ${args.transport}, reasoning low, maxTokens ${args.maxTokens}`);
	console.log("");

	for (let turn = 1; turn <= args.turns; turn++) {
		const prompt = buildPrompt(turn);
		const promptTokens = estimateTokens(prompt);
		const previousMessagesLength = session.messages.length;
		const websocketStatsBefore = getWebSocketStatsSnapshot(session.sessionId);
		const startedAt = Date.now();
		await session.prompt(prompt);
		const elapsedMs = Date.now() - startedAt;
		turnElapsedMs.push(elapsedMs);

		const newMessages = session.messages.slice(previousMessagesLength);
		const assistantMessages = newMessages.filter((message): message is AssistantMessage =>
			Boolean(message && typeof message === "object" && (message as { role?: unknown }).role === "assistant"),
		);
		const toolResults = newMessages.filter((message) =>
			Boolean(message && typeof message === "object" && (message as { role?: unknown }).role === "toolResult"),
		);

		if (assistantMessages.length < 2 || toolResults.length < 1) {
			throw new Error(
				`Turn ${turn} did not execute the expected tool loop. assistants=${assistantMessages.length} toolResults=${toolResults.length}`,
			);
		}

		let turnInput = 0;
		let turnOutput = 0;
		let turnCacheRead = 0;
		let turnCacheWrite = 0;
		let turnTotal = 0;

		for (let i = 0; i < assistantMessages.length; i++) {
			const assistant = assistantMessages[i];
			const record: SubrequestRecord = {
				turn,
				subrequest: i + 1,
				elapsedMs,
				usage: assistant.usage,
				stopReason: assistant.stopReason,
				text: getAssistantText(assistant),
			};
			records.push(record);

			turnInput += assistant.usage.input;
			turnOutput += assistant.usage.output;
			turnCacheRead += assistant.usage.cacheRead;
			turnCacheWrite += assistant.usage.cacheWrite;
			turnTotal += assistant.usage.totalTokens;

			const monotonic =
				previousCacheRead === null ? "n/a" : assistant.usage.cacheRead >= previousCacheRead ? "yes" : "NO";
			console.log(
				[
					`turn ${String(turn).padStart(2, "0")}.${i + 1}`,
					`elapsed ${(elapsedMs / 1000).toFixed(1)}s`,
					`prompt~${promptTokens}`,
					`stop ${assistant.stopReason}`,
					`in ${assistant.usage.input}`,
					`out ${assistant.usage.output}`,
					`cache ${assistant.usage.cacheRead}/${assistant.usage.cacheWrite}`,
					`total ${assistant.usage.totalTokens}`,
					`cache>=prev ${monotonic}`,
				].join(" | "),
			);

			if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
				throw new Error(
					`Turn ${turn}.${i + 1} ended with stopReason=${assistant.stopReason}: ${assistant.errorMessage || "unknown error"}`,
				);
			}
			previousCacheRead = assistant.usage.cacheRead;
		}

		const websocketStatsAfter = getWebSocketStatsSnapshot(session.sessionId);
		const websocketStatsForTurn = diffWebSocketStats(websocketStatsAfter, websocketStatsBefore);
		console.log(
			[
				`turn ${String(turn).padStart(2, "0")} agg`,
				`assistants ${assistantMessages.length}`,
				`toolResults ${toolResults.length}`,
				`in ${turnInput}`,
				`out ${turnOutput}`,
				`cache ${turnCacheRead}/${turnCacheWrite}`,
				`total ${turnTotal}`,
			].join(" | "),
		);
		console.log(formatWebSocketStats(`turn ${String(turn).padStart(2, "0")}`, websocketStatsForTurn));
	}

	const violations = records
		.map((record, index) => {
			if (index === 0) return null;
			const previous = records[index - 1];
			if (record.usage.cacheRead >= previous.usage.cacheRead) return null;
			return {
				turn: record.turn,
				subrequest: record.subrequest,
				previous: previous.usage.cacheRead,
				current: record.usage.cacheRead,
			};
		})
		.filter((value): value is NonNullable<typeof value> => value !== null);

	const totalElapsedMs = turnElapsedMs.reduce((sum, value) => sum + value, 0);
	console.log("");
	console.log(
		[
			"timing",
			`turns ${turnElapsedMs.length}`,
			`total ${(totalElapsedMs / 1000).toFixed(1)}s`,
			`avg ${(average(turnElapsedMs) / 1000).toFixed(2)}s`,
			`p50 ${(percentile(turnElapsedMs, 50) / 1000).toFixed(2)}s`,
			`p95 ${(percentile(turnElapsedMs, 95) / 1000).toFixed(2)}s`,
			`max ${(Math.max(...turnElapsedMs) / 1000).toFixed(2)}s`,
		].join(" | "),
	);
	const websocketStats = getOpenAICodexWebSocketDebugStats(session.sessionId);
	const requestedWebsocket =
		args.transport === "websocket" || args.transport === "websocket-cached" || args.transport === "auto";
	const observedWebsocket = Boolean(websocketStats && websocketStats.requests > 0);
	console.log(
		[
			"transport summary",
			`requested ${args.transport}`,
			`observed ${observedWebsocket ? "websocket" : "sse/no-websocket"}`,
			`sseFallbackSuspected ${requestedWebsocket && !observedWebsocket ? "yes" : "no"}`,
			`cachedContext ${websocketStats?.cachedContextRequests ? "yes" : "no"}`,
			`storeTrue ${websocketStats ? `${websocketStats.storeTrueRequests}/${websocketStats.requests}` : "0/0"}`,
			`delta ${websocketStats ? `${websocketStats.deltaRequests}/${websocketStats.requests}` : "0/0"}`,
			`full ${websocketStats ? `${websocketStats.fullContextRequests}/${websocketStats.requests}` : "0/0"}`,
		].join(" | "),
	);
	if (websocketStats) {
		console.log(
			[
				"websocket details",
				`requests ${websocketStats.requests}`,
				`connections created/reused ${websocketStats.connectionsCreated}/${websocketStats.connectionsReused}`,
				`cachedContext ${websocketStats.cachedContextRequests}`,
				`storeTrue ${websocketStats.storeTrueRequests}`,
				`full/delta ${websocketStats.fullContextRequests}/${websocketStats.deltaRequests}`,
				`lastInputItems ${websocketStats.lastInputItems}`,
				`lastDeltaItems ${websocketStats.lastDeltaInputItems ?? "n/a"}`,
				`lastPreviousResponseId ${websocketStats.lastPreviousResponseId ?? "n/a"}`,
			].join(" | "),
		);
	}
	console.log(`subrequest cache read monotonic: ${violations.length === 0 ? "yes" : "NO"}`);
	if (violations.length > 0) {
		console.log("violations:");
		for (const violation of violations) {
			console.log(`  turn ${violation.turn}.${violation.subrequest}: ${violation.previous} -> ${violation.current}`);
		}
	}
	console.log(`session file: ${session.sessionFile}`);

	unsubscribe();
	session.dispose();
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(message);
	process.exitCode = 1;
});
