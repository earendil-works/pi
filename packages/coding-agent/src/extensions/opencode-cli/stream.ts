import { realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	calculateCost,
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Model,
	type ModelThinkingLevel,
	normalizeContext,
	type SimpleStreamOptions,
	type ToolCall,
} from "@earendil-works/pi-ai";
import { opencodeBin, usesV2Cli } from "./cli.ts";
import { objectRecord, safeJson } from "./json.ts";
import { reasoningCliArgs } from "./models.ts";
import { runOpenCodeProcess } from "./process.ts";
import {
	buildContinuationPrompt,
	buildPrompt,
	imageContentsForModel,
	serializedTranscriptParts,
	serializeTools,
	writeImageFiles,
} from "./prompt.ts";
import {
	AGENT_ID,
	continuationDelta,
	createTempAgentDir,
	deleteOpenCodeSession,
	dropOpencodeSession,
	ensurePiSessionDir,
	getPiSessionState,
} from "./sessions.ts";
import {
	detectXmlToolUse,
	parseToolCallResponse,
	toolCallRejectionMessage,
	translateNativeToolCall,
} from "./tool-calls.ts";
import type { ParsedToolCall, ToolCallParseResult } from "./types/tool-calls.ts";

const STDERR_LIMIT = 20_000;

/**
 * Upper bound for every model turn, applied even when Pi supplies no
 * `timeoutMs`. A session ID reused from the wrong project directory hangs
 * with empty stdout/stderr, so no turn may wait indefinitely (#73).
 */
const DEFAULT_TURN_TIMEOUT_MS = 180_000;

type ToolCallFailure = Extract<ToolCallParseResult, { ok: false }>;

/** Accumulated state of one OpenCode turn, mutated as events arrive. */
type TurnLog = {
	text: string;
	thinking: string;
	stderr: string;
	sessionId: string | undefined;
	opencodeToolUse: string | undefined;
	nativeToolRequests: { name: string; arguments: unknown }[];
	nativeTextMark: number;
	stepNativeCalls: (ParsedToolCall | undefined)[];
	nativeCalls: ParsedToolCall[] | undefined;
	opencodeError: string | undefined;
	finishReason: "stop" | "length";
};

/** Fixed inputs the line handler needs besides the mutable log. */
type LineDeps = {
	model: Model<Api>;
	output: AssistantMessage;
	options: SimpleStreamOptions | undefined;
	allowedToolNames: Set<string>;
	projectDirs: string[];
	nativeStepEnd: Error;
};

type TurnDecision =
	| { kind: "success"; toolCalls: ParsedToolCall[]; displayText: string }
	| { kind: "error"; error: Error; toolCallFailure?: ToolCallFailure }
	| { kind: "recoverable"; error: Error; toolCallFailure?: ToolCallFailure };

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

function setEstimatedUsage(model: Model<Api>, output: AssistantMessage, prompt: string, text: string) {
	if (output.usage.totalTokens > 0) return;
	output.usage.input = estimateTokens(prompt);
	output.usage.output = estimateTokens(text);
	output.usage.totalTokens = output.usage.input + output.usage.output;
	calculateCost(model, output.usage);
}

/**
 * Effective per-turn timeout: honor Pi's `timeoutMs` when it is a positive
 * finite number, otherwise fall back to the unconditional internal bound so
 * no turn can hang indefinitely (#73).
 */
export function resolveTurnTimeoutMs(timeoutMs: unknown): number {
	return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
		? timeoutMs
		: DEFAULT_TURN_TIMEOUT_MS;
}

/** Build the `opencode run` argument array for one attempt. */
function buildOpenCodeArgs(input: {
	model: Model<Api>;
	v2: boolean;
	reasoning: ModelThinkingLevel | undefined;
	sessionDir: string;
	continuationSessionId: string | undefined;
	imagePaths: string[];
}): string[] {
	const variant =
		input.reasoning && input.reasoning !== "off" ? input.model.thinkingLevelMap?.[input.reasoning] : undefined;
	const args = [
		"run",
		"-m",
		input.v2 && typeof variant === "string" && variant.trim() ? `${input.model.id}#${variant}` : input.model.id,
		"--agent",
		AGENT_ID,
		"--format",
		"json",
		...(input.v2 ? ["--standalone"] : ["--dir", input.sessionDir]),
	];
	if (input.continuationSessionId) {
		args.push("--session", input.continuationSessionId);
	}
	args.push(...reasoningCliArgs(input.reasoning, input.v2 ? undefined : input.model.thinkingLevelMap));
	for (const path of input.imagePaths) args.push("--file", path);
	return args;
}

/** Parse and dispatch one line of OpenCode JSON output. */
async function handleOpenCodeLine(line: string, log: TurnLog, deps: LineDeps): Promise<void> {
	// Output after a translated native step belongs to a run Pi already ended.
	if (!line.trim() || log.nativeCalls) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		// Plugins share OpenCode's stdout; keep stray log lines as diagnostics.
		log.stderr = `${log.stderr}\n${line}`.slice(-STDERR_LIMIT);
		return;
	}
	const event = objectRecord(parsed);
	const part = objectRecord(event?.part);
	if (!event || typeof event.type !== "string" || (event.part !== undefined && !part)) {
		throw new Error("Invalid OpenCode event envelope");
	}
	await deps.options?.onProviderStreamEvent?.(event, deps.model);

	// Every JSON event carries the OpenCode session ID (#71).
	if (typeof event.sessionID === "string" && event.sessionID) {
		log.sessionId = event.sessionID;
	} else if (typeof part?.sessionID === "string" && part.sessionID) {
		log.sessionId = part.sessionID;
	}

	if (event.type === "text" || event.type === "reasoning") {
		if (typeof part?.text !== "string") {
			throw new Error("Invalid OpenCode event text");
		}
		if (event.type === "text") log.text += part.text;
		else log.thinking += part.text;
		return;
	}

	if (event.type === "step_finish") {
		if (/length|max.?tokens/i.test(String(part?.reason ?? ""))) {
			log.finishReason = "length";
		}
		const tokens = objectRecord(part?.tokens);
		if (tokens) {
			const cache = objectRecord(tokens.cache);
			deps.output.usage.input = Number(tokens.input ?? 0);
			deps.output.usage.output = Number(tokens.output ?? 0) + Number(tokens.reasoning ?? 0);
			deps.output.usage.cacheRead = Number(cache?.read ?? 0);
			deps.output.usage.cacheWrite = Number(cache?.write ?? 0);
			deps.output.usage.totalTokens = Number(
				tokens.total ??
					deps.output.usage.input +
						deps.output.usage.output +
						deps.output.usage.cacheRead +
						deps.output.usage.cacheWrite,
			);
			calculateCost(deps.model, deps.output.usage);
		}
		const calls = log.stepNativeCalls;
		log.stepNativeCalls = [];
		// A fully translatable step ends the turn like a normal tool-call response.
		// Otherwise OpenCode continues and the model sees the blocker's correction.
		if (calls.length > 0 && calls.every(Boolean)) {
			log.nativeCalls = calls as ParsedToolCall[];
			throw deps.nativeStepEnd;
		}
		return;
	}

	if (event.type === "tool_use") {
		log.opencodeToolUse = part?.tool ? String(part.tool) : "unknown";
		log.nativeTextMark = log.text.length;
		const input = objectRecord(part?.state)?.input;
		log.nativeToolRequests.push({ name: log.opencodeToolUse, arguments: input });
		log.stepNativeCalls.push(
			translateNativeToolCall(log.opencodeToolUse, input, deps.allowedToolNames, deps.projectDirs),
		);
		return;
	}

	if (event.type === "error") {
		const error = objectRecord(event.error);
		const message = objectRecord(error?.data)?.message ?? error?.message ?? part?.message;
		log.opencodeError = typeof message === "string" && message.trim() ? message.trim() : safeJson(event);
		log.stderr = `${log.stderr}\n${log.opencodeError}`.slice(-STDERR_LIMIT);
	}
}

/** Decide what the accumulated turn output means, or which error ends it. */
function decideTurn(input: { log: TurnLog; allowedToolNames: Set<string>; allowRecovery: boolean }): TurnDecision {
	const { log, allowedToolNames, allowRecovery } = input;
	const toolCallResult = parseToolCallResponse(log.text, allowedToolNames);
	if (!toolCallResult.ok) {
		return {
			kind: "error",
			error: new Error(toolCallRejectionMessage(toolCallResult, allowedToolNames)),
			toolCallFailure: toolCallResult,
		};
	}
	// Unrecoverable marker text is stripped so it never leaks into the
	// visible chat response; remaining prose still displays normally.
	const displayText = toolCallResult.cleanedText ?? log.text;
	let textCalls = toolCallResult.calls;
	// DeepSeek sometimes writes its only calls in the reasoning and replies
	// with nothing, which would end the turn silently.
	if (textCalls.length === 0 && !log.nativeCalls && !displayText.trim()) {
		let reasoningResult = parseToolCallResponse(log.thinking, allowedToolNames);
		// Markers stripped with no call surviving were meant as calls too.
		if (reasoningResult.ok && reasoningResult.calls.length === 0 && reasoningResult.cleanedText !== undefined) {
			reasoningResult = { ok: false, rejection: { reason: "malformed_markers" } };
		}
		if (!reasoningResult.ok) {
			return {
				kind: "error",
				error: new Error(toolCallRejectionMessage(reasoningResult, allowedToolNames)),
				toolCallFailure: reasoningResult,
			};
		}
		textCalls = reasoningResult.calls;
	}
	// A blocked native call with no usable Pi call recovers: nothing after it
	// to answer with, or prose while Pi exposes tools to try (e.g. "please run
	// a curl"). A valid call in text or reasoning is used instead of retrying;
	// with no Pi tools the prose is the model's explanation and stays final.
	if (
		log.opencodeToolUse &&
		!log.nativeCalls &&
		textCalls.length === 0 &&
		(!log.text.slice(log.nativeTextMark).trim() || allowedToolNames.size > 0)
	) {
		return {
			kind: "recoverable",
			error: new Error(
				`OpenCode could not use the available Pi tools${allowRecovery ? "" : " after one recovery attempt"} (blocked native tool: ${JSON.stringify(log.opencodeToolUse)}). Retry the request or select another OpenCode model.`,
			),
		};
	}
	const toolCalls = [...textCalls, ...(log.nativeCalls ?? [])];
	if (toolCalls.length === 0 && displayText.trim()) {
		// Check if the model tried to use XML-style tool-use instead of
		// <pi_tool_call> markers — a common mistake with Claude-based models.
		const xmlTool = detectXmlToolUse(displayText);
		if (xmlTool) {
			return {
				kind: "error",
				error: new Error(
					`OpenCode attempted to use its disabled native tool (${JSON.stringify(xmlTool)}). This bridge only accepts <pi_tool_call>{"name":"...","arguments":{}}</pi_tool_call> markers. Do not use XML-style tool-use syntax.`,
				),
			};
		}
	}
	if (toolCalls.length === 0 && !displayText.trim() && log.thinking.trim()) {
		return {
			kind: "recoverable",
			error: new Error(
				`OpenCode returned only reasoning without an answer or Pi tool call${allowRecovery ? "" : " after one recovery attempt"}. Retry the request or select another OpenCode model.`,
			),
		};
	}
	if (toolCalls.length === 0 && !displayText.trim() && !log.thinking.trim()) {
		const stderrMsg = log.stderr.trim();
		if (stderrMsg) {
			return { kind: "error", error: new Error(`OpenCode returned stderr: ${stderrMsg}`) };
		}
		// The model may have emitted text events with empty strings, or
		// may have produced reasoning-only output that was not captured
		// as assistant text. Provide a clearer diagnostic.
		const rawTextPreview = log.text
			? `raw text length=${log.text.length} (trimmed to "${log.text.slice(0, 80).replace(/\n/g, " ")}")`
			: "no text events received";
		const rawThinkingPreview = log.thinking ? `thinking length=${log.thinking.length}` : "no thinking output";
		return {
			kind: "error",
			error: new Error(
				`OpenCode returned empty assistant response (${rawTextPreview}; ${rawThinkingPreview}). This can happen with some free models when the prompt is too long, the model times out, or the model is overloaded. Retry the request or select another OpenCode model.`,
			),
		};
	}
	return { kind: "success", toolCalls, displayText };
}

/** Push thinking, tool-call or text events for a successful turn. */
function emitTurn(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	turn: {
		thinking: string;
		reasoning: ModelThinkingLevel | undefined;
		toolCalls: ParsedToolCall[];
		displayText: string;
		finishReason: "stop" | "length";
	},
): void {
	if (turn.thinking && turn.reasoning && turn.reasoning !== "off") {
		const thinkingIndex = output.content.length;
		output.content.push({ type: "thinking", thinking: turn.thinking });
		stream.push({
			type: "thinking_start",
			contentIndex: thinkingIndex,
			partial: output,
		});
		stream.push({
			type: "thinking_delta",
			contentIndex: thinkingIndex,
			delta: turn.thinking,
			partial: output,
		});
		stream.push({
			type: "thinking_end",
			contentIndex: thinkingIndex,
			content: turn.thinking,
			partial: output,
		});
	}

	if (turn.toolCalls.length > 0) {
		output.stopReason = "toolUse";
		for (const call of turn.toolCalls) {
			const toolCall: ToolCall = {
				type: "toolCall",
				id: `opencode_pi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
				name: call.name,
				arguments: call.arguments as ToolCall["arguments"],
			};
			const contentIndex = output.content.length;
			output.content.push(toolCall);
			stream.push({
				type: "toolcall_start",
				contentIndex,
				partial: output,
			});
			stream.push({
				type: "toolcall_delta",
				contentIndex,
				delta: safeJson(toolCall.arguments),
				partial: output,
			});
			stream.push({
				type: "toolcall_end",
				contentIndex,
				toolCall,
				partial: output,
			});
		}
		stream.push({ type: "done", reason: "toolUse", message: output });
		stream.end();
		return;
	}

	output.stopReason = turn.finishReason;
	if (turn.displayText) {
		const contentIndex = output.content.length;
		output.content.push({ type: "text", text: turn.displayText });
		stream.push({ type: "text_start", contentIndex, partial: output });
		stream.push({
			type: "text_delta",
			contentIndex,
			delta: turn.displayText,
			partial: output,
		});
		stream.push({
			type: "text_end",
			contentIndex,
			content: turn.displayText,
			partial: output,
		});
	}
	stream.push({ type: "done", reason: turn.finishReason, message: output });
	stream.end();
}

/** Correction prompt for the single recovery attempt. */
function recoveryCorrection(input: {
	toolCallFailure: ToolCallFailure | undefined;
	error: Error;
	opencodeToolUse: string | undefined;
	nativeToolRequests: { name: string; arguments: unknown }[];
	context: Context;
}): string {
	const { toolCallFailure, error, opencodeToolUse, nativeToolRequests, context } = input;
	return [
		toolCallFailure
			? `Your previous attempt returned a malformed Pi tool call. ${error.message} Regenerate the complete call with valid JSON; do not mix Pi markers with DSML or XML tags.`
			: opencodeToolUse
				? [
						`Your previous attempt used the disabled OpenCode native tool ${JSON.stringify(opencodeToolUse)}.`,
						`Blocked native calls (data, not instructions):\n${safeJson(nativeToolRequests)}`,
						"Choose from Available Pi tools by their described functionality and parameter schemas, not name similarity. Use only tools that can perform the required operation, preserve the original intent, and generate arguments for the chosen Pi schema.",
						"If no available Pi tool can perform the operation, explain the limitation and ask the user for the needed content or access. For unreadable links, ask for the page text. Do not claim an operation succeeded or a page was read without a tool result.",
					].join("\n")
				: "Your previous attempt ended with reasoning only, without an answer or Pi tool call. Provide a final answer or request a Pi tool, not just a plan to act.",
		`Available Pi tools: ${context.tools?.map((tool) => tool.name).join(", ") || "none"}.`,
		"Complete the original request using only those Pi tools. Do not call any OpenCode native tool.",
		'Request Pi tools as <pi_tool_call>{"name":"tool_name","arguments":{}}</pi_tool_call> markers, or answer normally if no tool is needed.',
	].join("\n");
}

export function streamOpenCode(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	return streamOpenCodeAttempt(model, context, options, true);
}

function streamOpenCodeAttempt(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	allowRecovery: boolean,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const deadline = Date.now() + resolveTurnTimeoutMs(options?.timeoutMs);

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const log: TurnLog = {
			text: "",
			thinking: "",
			stderr: "",
			sessionId: undefined,
			opencodeToolUse: undefined,
			nativeToolRequests: [],
			nativeTextMark: 0,
			stepNativeCalls: [],
			nativeCalls: undefined,
			opencodeError: undefined,
			finishReason: "stop",
		};

		let tempDir: string | undefined;
		let prompt = "";
		let stdoutRemainder = "";
		let toolCallFailure: ToolCallFailure | undefined;
		let recoverableFailure: Error | undefined;
		// Thrown from the event handler so the process runner stops OpenCode.
		const nativeStepEnd = new Error("OpenCode stopped after a translated native step");
		// Per-Pi-session reuse key supplied by Pi core (stable for the life of
		// the Pi session). Without it, every turn runs an isolated fresh
		// session in its own temporary directory.
		const piSessionId = typeof options?.sessionId === "string" && options.sessionId ? options.sessionId : undefined;
		const piState = piSessionId ? getPiSessionState(piSessionId) : undefined;

		try {
			// pi 1.x carries the current prompt and tools in transcript system messages.
			const { messages } = normalizeContext(context);
			context = {
				messages: messages.filter((message) => message.role !== "system"),
				systemPrompt: getCurrentSystemPrompt(messages),
				tools: getCurrentTools(messages),
			};
			const transcriptParts = serializedTranscriptParts(context.messages);
			const allowedToolNames = new Set(context.tools?.map((tool) => tool.name) ?? []);
			stream.push({ type: "start", partial: output });
			if (options?.signal?.aborted) throw new Error("Request was aborted");

			// Continuation decision (#75, #76): reuse the recorded OpenCode
			// session only when the model, tools, system prompt, and transcript
			// prefix all still match. Any drift restarts fresh — and the stale
			// session record is deleted so it cannot leak.
			// A payload hook may rewrite the prompt, so its session cannot be continued as a transcript prefix.
			const payloadHook = options?.onPayload;
			const delta =
				piState && !payloadHook ? continuationDelta(piState, model.id, context, transcriptParts) : undefined;
			if (piState?.opencodeSessionId && delta === undefined) {
				dropOpencodeSession(piState);
			}
			const isContinuation = delta !== undefined;
			prompt = isContinuation ? buildContinuationPrompt(delta) : buildPrompt(context);
			const sentMessages = isContinuation
				? context.messages.slice(transcriptParts.length - delta.length)
				: context.messages;

			const sessionDir = piState
				? await ensurePiSessionDir(piState)
				: await createTempAgentDir().then((dir) => {
						tempDir = dir;
						return dir;
					});
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			const projectDirs = [sessionDir, await realpath(sessionDir).catch(() => sessionDir)];
			const images = imageContentsForModel(sentMessages, model.input.includes("image"));
			const imagePaths = await writeImageFiles(images, sessionDir);
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			const v2 = await usesV2Cli();
			const requestedReasoning = options?.reasoning as ModelThinkingLevel | undefined;
			const args = buildOpenCodeArgs({
				model,
				v2,
				reasoning: requestedReasoning,
				sessionDir,
				continuationSessionId: isContinuation ? piState?.opencodeSessionId : undefined,
				imagePaths,
			});

			const deps: LineDeps = {
				model,
				output,
				options,
				allowedToolNames,
				projectDirs,
				nativeStepEnd,
			};
			const handleLine = (line: string) => handleOpenCodeLine(line, log, deps);

			const result = await runOpenCodeProcess(opencodeBin(), args, {
				cwd: v2 ? sessionDir : undefined,
				input: async () => {
					if (!payloadHook) return prompt;
					const replacement = await payloadHook({ prompt }, model);
					if (replacement === undefined) return prompt;
					const payload = objectRecord(replacement);
					if (typeof payload?.prompt !== "string") {
						throw new Error("OpenCode CLI payload must be an object with a string prompt");
					}
					prompt = payload.prompt;
					return prompt;
				},
				// A CLI subprocess has no HTTP status; 0 marks the non-HTTP transport.
				onStart: () => options?.onResponse?.({ status: 0, headers: { "x-pi-transport": "opencode-cli" } }, model),
				timeoutMs: resolveTurnTimeoutMs(options?.timeoutMs),
				signal: options?.signal,
				env: {
					...process.env,
					...options?.env,
					...(v2 ? { PWD: sessionDir } : {}),
					OPENCODE_DISABLE_UPDATE_CHECK: "1",
					OPENCODE_CONFIG_DIR: join(sessionDir, ".opencode"),
				},
				onStdout: async (chunk) => {
					stdoutRemainder += chunk;
					const lines = stdoutRemainder.split(/\r?\n/);
					stdoutRemainder = lines.pop() ?? "";
					for (const line of lines) await handleLine(line);
				},
				onEnd: () => handleLine(stdoutRemainder),
			}).catch((error: unknown) => {
				// Stopping OpenCode after a translated native step is a normal end of turn.
				if (error === nativeStepEnd) return undefined;
				throw error;
			});
			if (result) {
				log.stderr = (log.stderr + result.stderr).slice(-STDERR_LIMIT);
				if (result.code !== 0) {
					throw new Error(log.stderr.trim() || `opencode exited with code ${result.code}`);
				}
			}
			if (log.opencodeError) throw new Error(log.opencodeError);

			const decision = decideTurn({ log, allowedToolNames, allowRecovery });
			if (decision.kind !== "success") {
				if (decision.toolCallFailure) toolCallFailure = decision.toolCallFailure;
				if (decision.kind === "recoverable") recoverableFailure = decision.error;
				throw decision.error;
			}
			const { toolCalls, displayText } = decision;
			setEstimatedUsage(model, output, prompt, log.text + log.thinking);
			// The turn succeeded: record the session for reuse, or delete the
			// one-shot session record so it cannot accumulate (#71, #75).
			// A session holding a blocked native call cannot be continued as a transcript prefix.
			if (piState && !payloadHook && !log.nativeCalls) {
				piState.opencodeSessionId = log.sessionId ?? piState.opencodeSessionId;
				piState.modelId = model.id;
				piState.toolsKey = serializeTools(context.tools);
				piState.systemPrompt = context.systemPrompt ?? "";
				piState.sentParts = transcriptParts;
			} else {
				if (piState) dropOpencodeSession(piState);
				deleteOpenCodeSession(log.sessionId);
			}

			emitTurn(stream, output, {
				thinking: log.thinking,
				reasoning: requestedReasoning,
				toolCalls,
				displayText,
				finishReason: log.finishReason,
			});
		} catch (error) {
			if (toolCallFailure && toolCallFailure.rejection.reason !== "unavailable_tool" && error instanceof Error) {
				recoverableFailure = error;
				if (!allowRecovery) error.message += " Recovery failed after one attempt.";
			}
			// Any error, timeout, or abort drops the session ID so the next turn
			// starts fresh with the full transcript; the failed session record is
			// deleted best-effort and never fails the turn (#71, #75).
			deleteOpenCodeSession(log.sessionId);
			if (piState) dropOpencodeSession(piState);
			const remainingMs = deadline - Date.now();
			if (
				recoverableFailure &&
				error === recoverableFailure &&
				allowRecovery &&
				!options?.signal?.aborted &&
				remainingMs > 0
			) {
				setEstimatedUsage(model, output, prompt, log.text + log.thinking);
				const correction = recoveryCorrection({
					toolCallFailure,
					error: recoverableFailure,
					opencodeToolUse: log.opencodeToolUse,
					nativeToolRequests: log.nativeToolRequests,
					context,
				});
				// A fresh attempt keeps rejected native calls out of the continued transcript.
				const recovery = streamOpenCodeAttempt(
					model,
					{
						...context,
						messages: [...context.messages, { role: "user", content: correction, timestamp: Date.now() }],
					},
					{ ...options, timeoutMs: remainingMs },
					false,
				);
				for await (const event of recovery) {
					if (event.type === "start") continue;
					const message = event.type === "done" ? event.message : event.type === "error" ? event.error : undefined;
					if (message) {
						for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
							message.usage[key] += output.usage[key];
						}
						calculateCost(model, message.usage);
					}
					stream.push(event);
				}
				stream.end();
				return;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			// Ensure output.content has text so downstream tools (model-debugger,
			// Pi agent) see real content instead of flagging a "silent failure."
			if (output.content.length === 0) {
				output.content.push({ type: "text", text: `Error: ${output.errorMessage}` });
			}
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		} finally {
			// Only one-shot turns own their directory. Per-Pi-session directories
			// persist for reuse and are removed at session teardown (#74).
			if (tempDir) {
				await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
			}
		}
	})();

	return stream;
}
