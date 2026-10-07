#!/usr/bin/env node
/**
 * Live probe for in-context compaction cache stability.
 *
 * In-context compaction (coding-agent `compaction.inContext`) repeats the request the next
 * turn would send, appends a system message and a user message, and sets
 * `toolChoice: "none"`. It only saves money when the provider still reads the cached prefix
 * of that request. For each model this probe:
 *
 * 1. sends a tool-using conversation of about 12k tokens to write the prompt cache,
 * 2. sends the in-context compaction request on top of it with identical options,
 * 3. passes when that request reads at least 90% of the first prompt from cache, stops
 *    normally, calls no tools, and returns text.
 *
 * When a model fails, a control request (a plain user message with default tool choice)
 * separates "the compaction request breaks the cache" from "the cache did not hold".
 * Passing is necessary but not sufficient for `supportsInContextCompaction`: the synthetic history
 * has no native reasoning, so it misses models that drop the last turn's reasoning when a user
 * message follows it (openai-codex/gpt-5.5, moonshotai/kimi-k2.6, GPT-5.4 on opencode and
 * openrouter). Validate candidates in real pi sessions that compact right after a tool turn.
 *
 * Run from packages/ai with the source resolver so workspace packages load from source:
 *
 *   node --import ../coding-agent/src/experimental/source-resolver.ts \
 *     test/in-context-compaction-probe.ts --all
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
	appendInContextCompactionRequest,
	IN_CONTEXT_COMPACTION_INSTRUCTIONS,
	IN_CONTEXT_COMPACTION_PROMPT,
} from "../../coding-agent/src/core/compaction/compaction.ts";
import { ModelRuntime } from "../../coding-agent/src/core/model-runtime.ts";
import { normalizeContext } from "../src/compat.ts";
import type {
	Api,
	AssistantMessage,
	Message,
	Model,
	SimpleStreamOptions,
	ThinkingLevel,
	Tool,
	ToolCall,
	Usage,
} from "../src/types.ts";
import { contentText } from "../src/utils/text.ts";

const PASS_RATIO = 0.9;
const FILE_COUNT = 8;
const FILE_LINES = 90;

interface Args {
	all: boolean;
	providers: Set<string>;
	models: string[];
	reasoning: ThinkingLevel | "off";
	attempts: number;
	shapes: boolean;
	onlyShapes: Set<string>;
	json?: string;
}

type Verdict = "pass" | "fail" | "inconclusive" | "error";

interface ProbeResult {
	model: string;
	verdict: Verdict;
	detail: string;
	ratio?: number;
	controlRatio?: number;
	firstPromptTokens?: number;
	compactionUsage?: Usage;
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		all: false,
		providers: new Set(),
		models: [],
		reasoning: "low",
		attempts: 2,
		shapes: false,
		onlyShapes: new Set(),
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--all":
				args.all = true;
				break;
			case "--provider":
				args.providers.add(required(argv[++i], arg));
				break;
			case "--reasoning":
				args.reasoning = required(argv[++i], arg) as Args["reasoning"];
				break;
			case "--attempts":
				args.attempts = Math.max(1, Number.parseInt(required(argv[++i], arg), 10));
				break;
			case "--shapes":
				args.shapes = true;
				break;
			case "--shape":
				args.shapes = true;
				args.onlyShapes.add(required(argv[++i], arg));
				break;
			case "--json":
				args.json = required(argv[++i], arg);
				break;
			case "--help":
				printHelp();
				process.exit(0);
				break;
			default:
				if (arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
				args.models.push(arg);
		}
	}
	if (!args.all && args.models.length === 0 && args.providers.size === 0) {
		printHelp();
		process.exit(1);
	}
	return args;
}

function required(value: string | undefined, flag: string): string {
	if (!value) throw new Error(`Missing value for ${flag}`);
	return value;
}

function printHelp(): void {
	console.log(`Usage: node --import ../coding-agent/src/experimental/source-resolver.ts test/in-context-compaction-probe.ts [options] [provider/model ...]

Options:
  --all                Probe every model with supportsMidConvoSystemMessages that has configured auth
  --provider <id>      Probe those models of one provider (repeatable)
  --reasoning <level>  off | minimal | low | medium | high | xhigh | max. Default: low
  --attempts <n>       Attempts per model before reporting a cache miss. Default: 2
  --shapes             Compare request shapes (system or user instructions, with or without toolChoice "none")
                       instead of probing the production shape; includes models without mid-conversation system messages
  --shape <shape>      Compare only this shape, in the given order (repeatable): system+none | system | user+none | user
  --json <path>        Write results as JSON
`);
}

function supportsMidConvoSystemMessages(model: Model<Api>): boolean {
	return (
		(model.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)?.supportsMidConvoSystemMessages ===
		true
	);
}

const TOOLS: Tool[] = [
	{
		name: "read_file",
		description: "Read a file from the project. Returns the file contents.",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "Project-relative file path" } },
			required: ["path"],
		} as Tool["parameters"],
	},
	{
		name: "search",
		description: "Search the project for a regular expression. Returns matching lines.",
		parameters: {
			type: "object",
			properties: { pattern: { type: "string" }, path: { type: "string" } },
			required: ["pattern"],
		} as Tool["parameters"],
	},
];

const MODULES = ["config", "retry", "transport", "cache", "parser", "scheduler", "metrics", "format"];

function moduleSource(index: number): string {
	const name = MODULES[index % MODULES.length];
	const lines = [
		`// src/${name}.ts: ${name} module of the probe project`,
		`export const ${name}Version = ${index + 1};`,
	];
	for (let line = 0; line < FILE_LINES; line++) {
		lines.push(
			`export function ${name}Step${line}(input: number): number { return (input * ${line + 3} + ${index * 31 + line}) % 1009; }`,
		);
	}
	return lines.join("\n");
}

function foreignAssistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "probe",
		provider: "probe",
		model: "probe-history",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1,
	};
}

/** A deterministic tool-using conversation that ends with a user question, like a real last turn. */
function buildConversation(nonce: string): Message[] {
	const systemPrompt = [
		`Probe session ${nonce}.`,
		"You are a coding assistant working in a small TypeScript project. Use the tools to inspect files.",
		"Answer concisely. Preserve exact file paths and function names.",
	].join("\n");
	const messages: Message[] = [
		{ role: "system", content: systemPrompt, toolsAdded: TOOLS, timestamp: 1 },
		{ role: "user", content: "Read every module in src/ and tell me what the project does.", timestamp: 1 },
	];
	for (let index = 0; index < FILE_COUNT; index++) {
		const path = `src/${MODULES[index]}.ts`;
		const call: ToolCall = { type: "toolCall", id: `probe_call_${index}`, name: "read_file", arguments: { path } };
		messages.push(foreignAssistant([{ type: "text", text: `Reading ${path}.` }, call], "toolUse"));
		messages.push({
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: moduleSource(index) }],
			isError: false,
			timestamp: 1,
		});
	}
	messages.push(
		foreignAssistant(
			[
				{
					type: "text",
					text: `The project has ${FILE_COUNT} modules: ${MODULES.join(", ")}. Each exports numeric step functions.`,
				},
			],
			"stop",
		),
	);
	messages.push({ role: "user", content: "In one sentence, which module would handle retries?", timestamp: 1 });
	return messages;
}

function promptTokens(usage: Usage): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

function toolCalls(message: AssistantMessage): string[] {
	return message.content.filter((block) => block.type === "toolCall").map((block) => (block as ToolCall).name);
}

async function probeOnce(runtime: ModelRuntime, model: Model<Api>, reasoning: Args["reasoning"]): Promise<ProbeResult> {
	const id = `${model.provider}/${model.id}`;
	const options: SimpleStreamOptions = {
		sessionId: `pi-in-context-compaction-probe-${randomUUID()}`,
		...(model.reasoning && reasoning !== "off" ? { reasoning } : {}),
	};
	const request = (messages: Message[], extra: SimpleStreamOptions = {}) =>
		runtime.completeSimple(model, normalizeContext({ messages }), { ...options, ...extra });

	const history = buildConversation(randomUUID());
	const first = await request(history);
	if (first.stopReason === "error" || first.stopReason === "aborted") {
		return { model: id, verdict: "error", detail: `first request: ${first.errorMessage ?? first.stopReason}` };
	}
	const firstPrompt = promptTokens(first.usage);
	const reply =
		first.stopReason === "stop" && toolCalls(first).length === 0
			? first
			: foreignAssistant([{ type: "text", text: "The retry module handles retries." }], "stop");
	const conversation = [...history, reply];

	const compaction = await request(appendInContextCompactionRequest(conversation), { toolChoice: "none" });
	if (compaction.stopReason === "error" || compaction.stopReason === "aborted") {
		return {
			model: id,
			verdict: "fail",
			detail: `compaction request: ${compaction.errorMessage ?? compaction.stopReason}`,
		};
	}
	const ratio = firstPrompt > 0 ? compaction.usage.cacheRead / firstPrompt : 0;
	const base = { model: id, ratio, firstPromptTokens: firstPrompt, compactionUsage: compaction.usage };
	if (compaction.stopReason !== "stop")
		return { ...base, verdict: "fail", detail: `stop reason ${compaction.stopReason}` };
	if (toolCalls(compaction).length > 0)
		return { ...base, verdict: "fail", detail: `called ${toolCalls(compaction).join(", ")}` };
	if (contentText(compaction.content).trim().length === 0)
		return { ...base, verdict: "fail", detail: "no summary text" };
	if (ratio >= PASS_RATIO) return { ...base, verdict: "pass", detail: "cache held" };

	const control = await request([...conversation, { role: "user", content: "Reply with OK.", timestamp: 1 }]);
	const controlRatio = firstPrompt > 0 ? control.usage.cacheRead / firstPrompt : 0;
	return controlRatio >= PASS_RATIO
		? {
				...base,
				controlRatio,
				verdict: "fail",
				detail: "compaction request missed the cache; a plain follow-up hit it",
			}
		: {
				...base,
				controlRatio,
				verdict: "inconclusive",
				detail: "the cache did not hold for a plain follow-up either",
			};
}

type Shape = "system+none" | "system" | "user+none" | "user";
const SHAPES: Shape[] = ["system+none", "system", "user+none", "user"];

/** Compare how each compaction request shape reads the cache, after a plain follow-up confirms it works. */
async function probeShapes(
	runtime: ModelRuntime,
	model: Model<Api>,
	reasoning: Args["reasoning"],
	only: Set<string>,
): Promise<string> {
	const id = `${model.provider}/${model.id}`;
	const options: SimpleStreamOptions = {
		sessionId: `pi-in-context-compaction-probe-${randomUUID()}`,
		...(model.reasoning && reasoning !== "off" ? { reasoning } : {}),
	};
	const request = (messages: Message[], extra: SimpleStreamOptions = {}) =>
		runtime.completeSimple(model, normalizeContext({ messages }), { ...options, ...extra });
	const history = buildConversation(randomUUID());
	const first = await request(history);
	if (first.stopReason === "error" || first.stopReason === "aborted")
		return `${id} first request: ${first.errorMessage}`;
	const firstPrompt = promptTokens(first.usage);
	const reply =
		first.stopReason === "stop" && toolCalls(first).length === 0
			? first
			: foreignAssistant([{ type: "text", text: "The retry module handles retries." }], "stop");
	const conversation = [...history, reply];
	const describe = (label: string, message: AssistantMessage) => {
		if (message.stopReason === "error") return `${label}=error(${message.errorMessage?.slice(0, 80)})`;
		const ratio = firstPrompt > 0 ? ((message.usage.cacheRead / firstPrompt) * 100).toFixed(0) : "?";
		const calls = toolCalls(message);
		const summary = label === "control" || contentText(message.content).includes("## Goal") ? "" : "no-summary";
		const flags = [
			message.stopReason !== "stop" ? message.stopReason : "",
			calls.length > 0 ? `tools:${calls.join("+")}` : "",
			summary,
		];
		return `${label}=${ratio}%${flags
			.filter(Boolean)
			.map((flag) => `(${flag})`)
			.join("")}`;
	};
	const results = [
		describe("control", await request([...conversation, { role: "user", content: "Reply with OK.", timestamp: 1 }])),
	];
	for (const shape of only.size > 0 ? ([...only] as Shape[]) : SHAPES) {
		const messages = shape.startsWith("system")
			? appendInContextCompactionRequest(conversation)
			: [
					...conversation,
					{
						role: "user" as const,
						content: `${IN_CONTEXT_COMPACTION_INSTRUCTIONS}\n\n${IN_CONTEXT_COMPACTION_PROMPT}`,
						timestamp: 1,
					},
				];
		results.push(describe(shape, await request(messages, shape.endsWith("+none") ? { toolChoice: "none" } : {})));
	}
	const midConvo = supportsMidConvoSystemMessages(model) ? "mid-convo-system" : "collapsed-system";
	return `${id.padEnd(44)} prompt=${firstPrompt} ${midConvo} ${results.join(" ")}`;
}

async function probe(runtime: ModelRuntime, model: Model<Api>, args: Args): Promise<ProbeResult> {
	let result: ProbeResult | undefined;
	for (let attempt = 0; attempt < args.attempts; attempt++) {
		try {
			result = await probeOnce(runtime, model, args.reasoning);
		} catch (error) {
			result = {
				model: `${model.provider}/${model.id}`,
				verdict: "error",
				detail: error instanceof Error ? error.message : String(error),
			};
		}
		// Retry only cache misses: provider caches are best-effort and can miss on routing.
		if (result.verdict === "pass" || result.verdict === "error" || result.ratio === undefined) break;
	}
	return result!;
}

function format(result: ProbeResult): string {
	const ratio = result.ratio === undefined ? "" : ` read=${(result.ratio * 100).toFixed(1)}%`;
	const control = result.controlRatio === undefined ? "" : ` control=${(result.controlRatio * 100).toFixed(1)}%`;
	const prompt = result.firstPromptTokens === undefined ? "" : ` prompt=${result.firstPromptTokens}`;
	return `${result.verdict.toUpperCase().padEnd(12)} ${result.model}${prompt}${ratio}${control} ${result.detail}`;
}

const args = parseArgs(process.argv.slice(2));
const runtime = await ModelRuntime.create();
const selected = new Map<string, Model<Api>>();
for (const spec of args.models) {
	const slash = spec.indexOf("/");
	const model = slash > 0 ? runtime.getModel(spec.slice(0, slash), spec.slice(slash + 1)) : undefined;
	if (!model) throw new Error(`Unknown model: ${spec}`);
	selected.set(spec, model);
}
if (args.all || args.providers.size > 0) {
	for (const model of runtime.getModels()) {
		if (!args.shapes && !supportsMidConvoSystemMessages(model)) continue;
		if (args.providers.size > 0 && !args.providers.has(model.provider)) continue;
		if (!runtime.hasConfiguredAuth(model.provider)) continue;
		selected.set(`${model.provider}/${model.id}`, model);
	}
}

// Providers run in parallel; models of one provider run in sequence to respect rate limits.
const byProvider = new Map<string, Model<Api>[]>();
for (const model of selected.values()) {
	byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model]);
}
const results: ProbeResult[] = [];
await Promise.all(
	[...byProvider.values()].map(async (models) => {
		for (const model of models) {
			if (args.shapes) {
				console.log(
					await probeShapes(runtime, model, args.reasoning, args.onlyShapes).catch(
						(error) => `${model.provider}/${model.id} ${error}`,
					),
				);
				continue;
			}
			const result = await probe(runtime, model, args);
			results.push(result);
			console.log(format(result));
		}
	}),
);
results.sort((left, right) => left.model.localeCompare(right.model));
console.log(`\n${results.filter((result) => result.verdict === "pass").length}/${results.length} passed`);
if (args.json) writeFileSync(args.json, `${JSON.stringify(results, null, 2)}\n`);
process.exit(0);
