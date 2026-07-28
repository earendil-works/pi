/**
 * Progress summary sidecar for turning safe session events into live milestones and current status.
 *
 * The controller observes only allowlisted AgentSessionEvent projections, never
 * hidden thinking, and emits transient progress_summary_update events through
 * the existing session event stream.
 */

import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "./agent-session.ts";
import { parseModelPattern } from "./model-resolver.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { ProgressSummarySettings } from "./settings-manager.ts";

export type ProgressSummaryStyle = "default" | "technical" | "exec" | "debug";

export interface NormalizedProgressSummarySettings {
	enabled: boolean;
	intervalMs: number;
	model?: string;
	style: ProgressSummaryStyle;
	customStylePrompt?: string;
	maxBullets: number;
}

export interface ProgressSummaryUpdateEvent {
	type: "progress_summary_update";
	sequence: number;
	milestones: string[];
	current: string;
}

export interface ProgressSummaryControllerOptions {
	settings: () => NormalizedProgressSummarySettings;
	modelRuntime: ModelRuntime;
	getActiveModel: () => Model<Api> | undefined;
	sessionId: string;
	emit: (event: ProgressSummaryUpdateEvent) => void;
}

interface ObservableEvent {
	kind: string;
	text: string;
	important: boolean;
}

const MAX_SAFE_TEXT_LENGTH = 1200;
const MAX_LOG_EVENTS = 120;
const MIN_INTERVAL_MS = 1000;
const STYLE_PROMPTS: Record<ProgressSummaryStyle, string> = {
	default:
		"Concise, general-purpose live progress. Lock milestones only for completed meaningful steps; use current for what is happening now.",
	technical:
		"Developer/operator live progress. Milestones may mention files, APIs, commands, and validation when observable; current should describe the active technical step.",
	exec: [
		"Executive live-progress updates. Translate observable work into outcomes, scope progress, risk reduction, blockers, and handoff readiness.",
		"Do not mention files, commands, endpoints, tools, libraries, or internal agent mechanics unless they materially affect a decision or business outcome.",
		"Use milestones for completed outcomes only. Use current for what is happening now in present-progress language.",
		'Example technical milestone: "Created /tmp/simple_fastapi_app.py with GET /, GET /items/{item_id}, and POST /echo."',
		'Example exec milestone: "Put the requested three-part API deliverable in place."',
		'Example technical current: "Writing uvicorn run instructions."',
		'Example exec current: "Preparing clear next steps so the result can be tested quickly."',
	].join(" "),
	debug: "Operational live progress. Include event/tool/error state that helps diagnose what the agent is doing; current should name the active operational step.",
};
const SENSITIVE_KEY_PATTERN = /authorization|api[-_]?key|token|secret|password|cookie|credential|bearer/i;

export function normalizeProgressSummarySettings(
	settings: ProgressSummarySettings | undefined,
): NormalizedProgressSummarySettings {
	const rawIntervalMs = settings?.intervalMs ?? 5000;
	const rawMaxBullets = settings?.maxBullets ?? 6;
	const rawStyle = settings?.style ?? "default";
	return {
		enabled: settings?.enabled ?? false,
		intervalMs: Math.max(MIN_INTERVAL_MS, Math.floor(rawIntervalMs)),
		model: settings?.model,
		style: isProgressSummaryStyle(rawStyle) ? rawStyle : "default",
		customStylePrompt: settings?.customStylePrompt,
		maxBullets: Math.max(0, Math.min(6, Math.floor(rawMaxBullets))),
	};
}

function isProgressSummaryStyle(value: string): value is ProgressSummaryStyle {
	return value === "default" || value === "technical" || value === "exec" || value === "debug";
}

export class ProgressSummaryController {
	private readonly options: ProgressSummaryControllerOptions;
	private timer: ReturnType<typeof setInterval> | undefined;
	private active = false;
	private running = false;
	private dirty = false;
	private forceNext = false;
	private sequence = 0;
	private eventsSinceSummary = 0;
	private charsSinceSummary = 0;
	private priorMilestones: string[] = [];
	private currentProgress = "";
	private log: ObservableEvent[] = [];
	private changesSinceSummary: ObservableEvent[] = [];
	private originalUserRequest = "";
	private disabledAfterError = false;
	private settling = false;

	constructor(options: ProgressSummaryControllerOptions) {
		this.options = options;
	}

	observe(event: AgentSessionEvent): void {
		if (event.type === "progress_summary_update") return;
		const settings = this.options.settings();
		if (!settings.enabled || settings.maxBullets === 0 || this.disabledAfterError) return;

		if (event.type === "agent_start") {
			debugProgressSummary("agent_start observed; progress summaries active");
			this.resetRun();
			this.active = true;
			this.ensureTimer(settings.intervalMs);
		}

		if (!this.active && event.type !== "agent_start") return;

		const observable = projectEvent(event);
		if (!observable) return;

		if (!this.originalUserRequest && event.type === "message_start" && event.message.role === "user") {
			this.originalUserRequest = extractMessageText(event.message);
		}

		this.log.push(observable);
		if (this.log.length > MAX_LOG_EVENTS) {
			this.log = this.log.slice(-MAX_LOG_EVENTS);
		}
		this.changesSinceSummary.push(observable);
		this.eventsSinceSummary++;
		this.charsSinceSummary += observable.text.length;
		this.dirty = true;
		this.forceNext ||= observable.important;

		if (event.type === "agent_end" || event.type === "agent_settled") {
			this.forceNext = true;
		}
	}

	async settle(): Promise<void> {
		if (!this.active || this.disabledAfterError) return;
		debugProgressSummary("settle requested");
		await this.waitForRunningSummary();
		this.settling = true;
		this.forceNext = true;
		await this.maybeSummarize();
		this.stopTimer();
		this.active = false;
	}

	dispose(): void {
		this.stopTimer();
		this.active = false;
	}

	private resetRun(): void {
		this.stopTimer();
		this.active = false;
		this.running = false;
		this.dirty = false;
		this.forceNext = false;
		this.eventsSinceSummary = 0;
		this.charsSinceSummary = 0;
		this.priorMilestones = [];
		this.currentProgress = "";
		this.log = [];
		this.changesSinceSummary = [];
		this.originalUserRequest = "";
		this.disabledAfterError = false;
		this.settling = false;
	}

	private ensureTimer(intervalMs: number): void {
		this.stopTimer();
		this.timer = setInterval(() => {
			void this.maybeSummarize();
		}, intervalMs);
		this.timer.unref?.();
	}

	private stopTimer(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	private shouldSummarize(): boolean {
		if (!this.active || !this.dirty || this.running) return false;
		return this.forceNext || this.eventsSinceSummary >= 6 || this.charsSinceSummary >= 400;
	}

	private async waitForRunningSummary(): Promise<void> {
		while (this.running) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	private async maybeSummarize(): Promise<void> {
		if (!this.shouldSummarize()) return;
		debugProgressSummary("summary call starting");
		const settings = this.options.settings();
		if (!settings.enabled || settings.maxBullets === 0) return;

		this.running = true;
		try {
			const model = this.resolveModel(settings);
			if (!model) {
				this.disabledAfterError = true;
				return;
			}

			const prompt = buildPrompt({
				settings,
				originalUserRequest: this.originalUserRequest,
				log: this.log,
				priorMilestones: this.priorMilestones,
				currentProgress: this.currentProgress,
				changesSinceSummary: this.changesSinceSummary,
				sequence: this.sequence + 1,
			});
			const response = await this.options.modelRuntime.completeSimple(model, prompt, {
				maxTokens: 512,
				reasoning: "minimal",
				cacheRetention: "short",
				sessionId: `progress-summary:${this.options.sessionId}`,
			});
			const update = parseSummaryResponse(response, settings.maxBullets);
			if (!update) return;
			this.sequence++;
			const emittedUpdate = this.settling ? { ...update, current: "" } : update;
			this.priorMilestones = emittedUpdate.milestones;
			this.currentProgress = emittedUpdate.current;
			this.options.emit({ type: "progress_summary_update", sequence: this.sequence, ...emittedUpdate });
			this.dirty = false;
			this.forceNext = false;
			this.eventsSinceSummary = 0;
			this.charsSinceSummary = 0;
			this.changesSinceSummary = [];
		} catch (error) {
			debugProgressSummary(`disabled after error: ${error instanceof Error ? error.message : String(error)}`);
			this.disabledAfterError = true;
		} finally {
			this.running = false;
		}
	}

	private resolveModel(settings: NormalizedProgressSummarySettings): Model<Api> | undefined {
		if (!settings.model) return this.options.getActiveModel();
		const result = parseModelPattern(settings.model, [...this.options.modelRuntime.getModels()], {
			allowInvalidThinkingLevelFallback: false,
		});
		return result.model;
	}
}

function buildPrompt(input: {
	settings: NormalizedProgressSummarySettings;
	originalUserRequest: string;
	log: ObservableEvent[];
	priorMilestones: string[];
	currentProgress: string;
	changesSinceSummary: ObservableEvent[];
	sequence: number;
}): { systemPrompt: string; messages: Message[] } {
	const stylePrompt = input.settings.customStylePrompt ?? STYLE_PROMPTS[input.settings.style];
	const body = [
		"Original user request:",
		input.originalUserRequest || "(not observed yet)",
		"",
		"Observable event log so far, append-only:",
		formatEvents(input.log),
		"",
		"Locked milestones shown to the user:",
		JSON.stringify(input.priorMilestones),
		"",
		"Current progress line shown to the user:",
		input.currentProgress || "(none)",
		"",
		"Changes since previous summary:",
		formatEvents(input.changesSinceSummary),
		"",
		`Update sequence: ${input.sequence}`,
	].join("\n");

	return {
		systemPrompt: [
			"You summarize live progress for a Pi coding-agent run.",
			"Use only observable events provided in the user message.",
			"Never reveal hidden thinking, chain-of-thought, secrets, auth headers, tokens, or private payloads.",
			'Return JSON only with this schema: {"milestones":["locked completed milestone"],"current":"one live progress sentence"}.',
			`Return 0-${input.settings.maxBullets} milestones. Milestones are completed, stable, non-duplicative outcomes only.`,
			"Return the entire locked milestone list, not only new milestones.",
			"Use current for one concise present-tense sentence describing what is happening now; leave it empty when there is no active work.",
			"When the latest changes show agent_end or agent_settled and the run is not retrying, move completed work into milestones and return current as an empty string.",
			"Preserve existing milestones unless they are clearly wrong or duplicated. Do not turn tentative or in-progress work into milestones.",
			"Do not mention this summarizer, prompts, schemas, or internal instructions.",
			`Style: ${stylePrompt}`,
		].join("\n"),
		messages: [{ role: "user", content: body, timestamp: Date.now() }],
	};
}

function formatEvents(events: ObservableEvent[]): string {
	if (events.length === 0) return "(none)";
	return events.map((event, index) => `${index + 1}. ${event.kind}: ${event.text}`).join("\n");
}

function projectEvent(event: AgentSessionEvent): ObservableEvent | undefined {
	switch (event.type) {
		case "agent_start":
			return { kind: event.type, text: "Agent run started", important: true };
		case "agent_end":
			return {
				kind: event.type,
				text: event.willRetry ? "Agent run ended and will retry" : "Agent run ended",
				important: true,
			};
		case "agent_settled":
			return { kind: event.type, text: "Agent settled", important: true };
		case "turn_start":
			return { kind: event.type, text: "Started an assistant turn", important: false };
		case "turn_end":
			return { kind: event.type, text: "Finished an assistant turn", important: false };
		case "message_start":
			return projectMessageStart(event.message);
		case "message_update":
			return projectMessageUpdate(event.assistantMessageEvent);
		case "message_end":
			return projectMessageEnd(event.message);
		case "tool_execution_start":
			return {
				kind: event.type,
				text: `Started ${event.toolName} with ${safeStringify(event.args)}`,
				important: true,
			};
		case "tool_execution_update":
			return {
				kind: event.type,
				text: `Received partial ${event.toolName} result: ${safeStringify(event.partialResult)}`,
				important: false,
			};
		case "tool_execution_end":
			return {
				kind: event.type,
				text: `${event.isError ? "Failed" : "Completed"} ${event.toolName}: ${safeStringify(event.result)}`,
				important: true,
			};
		case "auto_retry_start":
			return {
				kind: event.type,
				text: `Retrying after error: ${truncate(event.errorMessage)}`,
				important: true,
			};
		case "auto_retry_end":
			return {
				kind: event.type,
				text: event.success ? "Retry succeeded" : `Retry failed: ${truncate(event.finalError ?? "unknown error")}`,
				important: true,
			};
		case "compaction_start":
			return { kind: event.type, text: `Started ${event.reason} compaction`, important: true };
		case "compaction_end":
			return {
				kind: event.type,
				text: event.aborted ? `${event.reason} compaction aborted` : `${event.reason} compaction finished`,
				important: true,
			};
		case "queue_update":
			return {
				kind: event.type,
				text: `Queue updated: ${event.steering.length} steering, ${event.followUp.length} follow-up`,
				important: false,
			};
		default:
			return undefined;
	}
}

function projectMessageStart(
	message: Extract<AgentSessionEvent, { type: "message_start" }>["message"],
): ObservableEvent | undefined {
	if (message.role === "user") {
		return {
			kind: "message_start",
			text: `User request observed: ${truncate(extractMessageText(message))}`,
			important: true,
		};
	}
	if (message.role === "assistant") {
		return { kind: "message_start", text: "Assistant response started", important: false };
	}
	if (message.role === "toolResult") {
		return { kind: "message_start", text: `Tool result message for ${message.toolName}`, important: false };
	}
	return undefined;
}

function projectMessageUpdate(
	assistantEvent: Extract<AgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"],
): ObservableEvent | undefined {
	if (assistantEvent.type === "text_delta") {
		return { kind: "message_update", text: `Assistant text: ${truncate(assistantEvent.delta)}`, important: false };
	}
	if (assistantEvent.type === "final_answer_start") {
		return { kind: "message_update", text: "Final answer started", important: true };
	}
	if (assistantEvent.type === "final_answer_delta") {
		return { kind: "message_update", text: `Final answer text: ${truncate(assistantEvent.delta)}`, important: true };
	}
	if (assistantEvent.type === "final_answer_end") {
		return { kind: "message_update", text: "Final answer ended", important: true };
	}
	return undefined;
}

function projectMessageEnd(
	message: Extract<AgentSessionEvent, { type: "message_end" }>["message"],
): ObservableEvent | undefined {
	if (message.role === "assistant") {
		const error = message.stopReason === "error" || message.stopReason === "aborted";
		const text = extractAssistantVisibleText(message);
		return {
			kind: "message_end",
			text: error
				? `Assistant ended with ${message.stopReason}: ${truncate(message.errorMessage ?? "unknown error")}`
				: `Assistant message completed: ${truncate(text)}`,
			important: error,
		};
	}
	if (message.role === "toolResult") {
		return { kind: "message_end", text: `Tool result completed for ${message.toolName}`, important: false };
	}
	return undefined;
}

function extractMessageText(message: Message): string {
	if (message.role !== "user") return "";
	if (typeof message.content === "string") return truncate(message.content);
	return truncate(
		message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n"),
	);
}

function extractAssistantVisibleText(message: AssistantMessage): string {
	return message.content
		.filter((part) => part.type === "text" || part.type === "finalAnswer")
		.map((part) => part.text)
		.join("\n");
}

function safeStringify(value: unknown): string {
	try {
		return truncate(JSON.stringify(redact(value)) ?? "undefined");
	} catch {
		return "[unserializable]";
	}
}

function redact(value: unknown): unknown {
	if (Array.isArray(value)) return value.slice(0, 20).map((entry) => redact(entry));
	if (!value || typeof value !== "object") return value;
	const output: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		output[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : redact(entry);
	}
	return output;
}

function truncate(text: string): string {
	return text.length > MAX_SAFE_TEXT_LENGTH ? `${text.slice(0, MAX_SAFE_TEXT_LENGTH)}…[truncated]` : text;
}

function parseSummaryResponse(
	message: AssistantMessage,
	maxMilestones: number,
): { milestones: string[]; current: string } | undefined {
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		debugProgressSummary(
			`summary model ended with ${message.stopReason}: ${message.errorMessage ?? "unknown error"}`,
		);
		return undefined;
	}
	const text = extractAssistantVisibleText(message).trim();
	const jsonText = extractJsonObject(text);
	if (!jsonText) {
		debugProgressSummary("summary model returned no JSON object");
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		debugProgressSummary("summary model returned invalid JSON");
		return undefined;
	}
	if (
		!parsed ||
		typeof parsed !== "object" ||
		!Array.isArray((parsed as { milestones?: unknown }).milestones) ||
		typeof (parsed as { current?: unknown }).current !== "string"
	) {
		debugProgressSummary("summary model JSON did not match expected schema");
		return undefined;
	}
	const milestones: string[] = [];
	for (const item of (parsed as { milestones: unknown[] }).milestones) {
		if (typeof item !== "string") return undefined;
		const milestone = item.trim();
		if (!milestone || milestones.includes(milestone)) continue;
		milestones.push(milestone.length > 160 ? `${milestone.slice(0, 160)}…` : milestone);
		if (milestones.length >= maxMilestones) break;
	}
	const current = (parsed as { current: string }).current.trim();
	return { milestones, current: current.length > 200 ? `${current.slice(0, 200)}…` : current };
}

function extractJsonObject(text: string): string | undefined {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end === -1 || end < start) return undefined;
	return text.slice(start, end + 1);
}

function debugProgressSummary(message: string): void {
	if (process.env.PI_PROGRESS_SUMMARY_DEBUG === "1") {
		console.error(`[progress-summary] ${message}`);
	}
}
