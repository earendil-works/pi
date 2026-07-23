import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getCwdRelativePath, resolvePath } from "../utils/paths.ts";

export const ANSTEEL_ROLES = ["tech-lead", "staff-engineer", "qa-engineer"] as const;

export type AnsteelRole = (typeof ANSTEEL_ROLES)[number];

export const ANSTEEL_DISCUSSION_STAGES = [
	"architecture",
	"staff-critique",
	"qa-critique",
	"architecture-revision",
	"staff-verification",
	"qa-verification",
	"consensus",
	"staff-sign-off",
	"qa-sign-off",
] as const;

export type AnsteelDiscussionStage = (typeof ANSTEEL_DISCUSSION_STAGES)[number];

export interface AnsteelRoleCall {
	role: AnsteelRole;
	stage: AnsteelDiscussionStage;
	prompt: string;
	round?: number;
}

export interface AnsteelTranscriptEntry extends AnsteelRoleCall {
	response: string;
}

export interface AnsteelDiscussionFailure {
	role: AnsteelRole;
	stage: AnsteelDiscussionStage;
	reason: string;
	timeoutMs?: number;
}

export type AnsteelStageAuditEventType =
	| "stage-prompt-start"
	| "stage-prompt-end"
	| "stage-prompt-error"
	| "stage-timeout"
	| "assistant-message-end"
	| "tool-execution-start"
	| "tool-execution-end";

/**
 * A redacted lifecycle event captured while a governance role handles one stage.
 * Tool arguments, output, provider payloads, and error text are intentionally excluded.
 */
export interface AnsteelStageAuditEvent {
	type: AnsteelStageAuditEventType;
	elapsedMs: number;
	toolName?: string;
	isError?: boolean;
	stopReason?: string;
	durationMs?: number;
}

export interface AnsteelStageAudit {
	role: AnsteelRole;
	stage: AnsteelDiscussionStage;
	round?: number;
	events: AnsteelStageAuditEvent[];
}

export const ANSTEEL_MAX_ARCHITECTURE_REVISION_ROUNDS = 2;
export const ANSTEEL_DEFAULT_STAGE_TIMEOUT_MS = 120_000;
export const ANSTEEL_DEFAULT_MAX_TOOL_CALLS_PER_STAGE = 4;
export const ANSTEEL_MAX_BASH_TIMEOUT_SECONDS = 20;
const ANSTEEL_MAX_STAGE_TIMEOUT_MS = 2_147_483_647;
const ANSTEEL_MAX_TOOL_CALLS_PER_STAGE = 32;
const ANSTEEL_ABORT_GRACE_MS = 250;

export interface AnsteelChallengeLedgerEntry {
	id: string;
	raisedBy: "staff-engineer" | "qa-engineer";
	round: number;
	status: "open" | "resolved";
}

export interface AnsteelRevisionRound {
	round: number;
	staffVerdict: "approved" | "rejected";
	qaVerdict: "approved" | "rejected";
	outcome: "approved" | "needs-revision";
}

export type AnsteelTerminationReason =
	| "stage-failure"
	| "stage-timeout"
	| "blank-response"
	| "invalid-verdict"
	| "invalid-challenge-ledger"
	| "unanswered-challenge"
	| "max-revision-rounds-exhausted"
	| "final-sign-off-rejected";

export type AnsteelSetupFailurePhase = "configuration" | "model-resolution" | "session-construction";

export class AnsteelGovernanceSetupError extends Error {
	readonly phase: AnsteelSetupFailurePhase;
	readonly role?: AnsteelRole;

	constructor(message: string, phase: AnsteelSetupFailurePhase, role?: AnsteelRole) {
		super(message);
		this.name = "AnsteelGovernanceSetupError";
		this.phase = phase;
		this.role = role;
	}
}

export interface AnsteelSessionCleanupFailure {
	role: AnsteelRole;
	reason: string;
}

export interface RunAnsteelDiscussionOptions {
	topic: string;
	runRole: (call: AnsteelRoleCall) => Promise<string>;
	stageTimeoutMs?: number;
	maxToolCallsPerStage?: number;
	abortRole?: (call: AnsteelRoleCall) => void | Promise<void>;
	getStageAudit?: (call: AnsteelRoleCall) => { events: AnsteelStageAuditEvent[] } | undefined;
}

export interface AnsteelDiscussionResult {
	topic: string;
	verdict: "approved" | "rejected";
	transcript: AnsteelTranscriptEntry[];
	stageAudits: AnsteelStageAudit[];
	challengeLedger: AnsteelChallengeLedgerEntry[];
	revisionRounds: AnsteelRevisionRound[];
	consensus?: string;
	failure?: AnsteelDiscussionFailure;
	cleanupFailures?: AnsteelSessionCleanupFailure[];
	terminationReason?: AnsteelTerminationReason;
	markdown: string;
}

/** Maps a completed review verdict to the CLI's process outcome. */
export function getAnsteelReviewExitCode(verdict: AnsteelDiscussionResult["verdict"]): 0 | 1 {
	return verdict === "approved" ? 0 : 1;
}

export const ANSTEEL_REVIEW_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;

export type AnsteelReviewTool = (typeof ANSTEEL_REVIEW_TOOLS)[number];

const ANSTEEL_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface AnsteelRoleConfig {
	model: string;
	tools: AnsteelReviewTool[];
	thinkingLevel?: ThinkingLevel;
}

export interface AnsteelConfig {
	roles: Record<AnsteelRole, AnsteelRoleConfig>;
	reportDirectory: string;
	stageTimeoutMs?: number;
	maxToolCallsPerStage?: number;
}

export interface AnsteelModelReference {
	provider: string;
	id: string;
}

export interface AnsteelRoleSession {
	prompt: (text: string) => Promise<string>;
	abort?: () => void | Promise<void>;
	dispose: () => void | Promise<void>;
	getLastStageAudit?: () => { events: AnsteelStageAuditEvent[] };
}

/** The minimal AgentSession surface needed to capture a single raw assistant turn. */
export interface AnsteelRawTurnSessionSource {
	prompt: (text: string) => Promise<void>;
	subscribeToAssistantMessageEnd: (listener: (message: unknown) => void) => () => void;
	subscribeToAgentEvent?: (listener: (event: unknown) => void) => () => void;
	abort?: () => void | Promise<void>;
	dispose: () => void | Promise<void>;
}

export interface CreateAnsteelRoleSessionOptions<TModel extends AnsteelModelReference> {
	role: AnsteelRole;
	model: TModel;
	tools: readonly AnsteelReviewTool[];
	thinkingLevel?: ThinkingLevel;
	cwd: string;
	maxToolCallsPerStage: number;
}

export interface RunAnsteelProjectReviewOptions<TModel extends AnsteelModelReference> {
	topic: string;
	cwd: string;
	config?: AnsteelConfig;
	resolveModel: (provider: string, id: string) => TModel | undefined;
	createRoleSession: (options: CreateAnsteelRoleSessionOptions<TModel>) => Promise<AnsteelRoleSession>;
}

export interface AnsteelProjectReviewResult<TModel extends AnsteelModelReference> extends AnsteelDiscussionResult {
	roleModels: Record<AnsteelRole, TModel>;
}

export interface WriteAnsteelReportOptions {
	reportDirectory: string;
	topic: string;
	markdown: string;
	now?: Date;
}

export interface CreateAnsteelSetupFailureMarkdownOptions {
	topic: string;
	config?: AnsteelConfig;
	error: unknown;
}

const DEFAULT_ROLE_TOOLS: Record<AnsteelRole, AnsteelReviewTool[]> = {
	"tech-lead": ["read", "grep", "find", "ls", "bash"],
	"staff-engineer": ["read", "grep", "find", "ls", "bash"],
	"qa-engineer": ["read", "grep", "find", "ls"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawAssistantText(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "assistant") return undefined;
	if (!Array.isArray(message.content)) return "";

	return message.content.reduce<string>((text, content) => {
		if (isRecord(content) && content.type === "text" && typeof content.text === "string") {
			return text + content.text;
		}
		return text;
	}, "");
}

function rawAssistantProviderError(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "assistant" || message.stopReason !== "error") return undefined;
	const reason =
		typeof message.errorMessage === "string" && message.errorMessage.trim().length > 0
			? sanitizeAnsteelFailureReason(message.errorMessage)
			: "The provider ended the role stage with an unspecified error";
	return `Ansteel role provider error: ${reason}`;
}

function elapsedSince(startedAt: number): number {
	return Math.max(0, Date.now() - startedAt);
}

function recordAnsteelAgentEvent(
	event: unknown,
	startedAt: number,
	toolStartedAt: Map<string, number>,
	events: AnsteelStageAuditEvent[],
): void {
	if (!isRecord(event) || typeof event.type !== "string") return;

	const elapsedMs = elapsedSince(startedAt);
	if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
		if (typeof event.toolCallId === "string") toolStartedAt.set(event.toolCallId, elapsedMs);
		events.push({ type: "tool-execution-start", elapsedMs, toolName: event.toolName });
		return;
	}
	if (event.type === "tool_execution_end" && typeof event.toolName === "string") {
		const startedAtMs = typeof event.toolCallId === "string" ? toolStartedAt.get(event.toolCallId) : undefined;
		events.push({
			type: "tool-execution-end",
			elapsedMs,
			toolName: event.toolName,
			...(typeof event.isError === "boolean" ? { isError: event.isError } : {}),
			...(startedAtMs === undefined ? {} : { durationMs: Math.max(0, elapsedMs - startedAtMs) }),
		});
		return;
	}
}

/**
 * Adapts a session so every review stage receives only the raw assistant text
 * emitted by that stage's prompt. Empty and aborted messages remain empty.
 */
export function createAnsteelRawTurnSession(source: AnsteelRawTurnSessionSource): AnsteelRoleSession {
	let lastStageAudit: { events: AnsteelStageAuditEvent[] } = { events: [] };
	return {
		prompt: async (text) => {
			const startedAt = Date.now();
			const toolStartedAt = new Map<string, number>();
			const auditEvents: AnsteelStageAuditEvent[] = [{ type: "stage-prompt-start", elapsedMs: 0 }];
			lastStageAudit = { events: auditEvents };
			const assistantMessages: unknown[] = [];
			const unsubscribe = source.subscribeToAssistantMessageEnd((message) => {
				assistantMessages.push(message);
				if (isRecord(message) && message.role === "assistant") {
					auditEvents.push({
						type: "assistant-message-end",
						elapsedMs: elapsedSince(startedAt),
						...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
					});
				}
			});
			const unsubscribeAgentEvents = source.subscribeToAgentEvent?.((event) => {
				recordAnsteelAgentEvent(event, startedAt, toolStartedAt, auditEvents);
			});
			let promptFailed = false;
			let promptFailure: unknown;

			try {
				await source.prompt(text);
			} catch (error) {
				promptFailed = true;
				promptFailure = error;
				auditEvents.push({ type: "stage-prompt-error", elapsedMs: elapsedSince(startedAt) });
			}
			const providerError = promptFailed ? undefined : rawAssistantProviderError(assistantMessages.at(-1));
			const primaryFailure = promptFailed ? promptFailure : providerError ? new Error(providerError) : undefined;
			if (!promptFailed) {
				auditEvents.push({
					type: primaryFailure ? "stage-prompt-error" : "stage-prompt-end",
					elapsedMs: elapsedSince(startedAt),
				});
			}

			const listenerCleanupFailures: unknown[] = [];
			try {
				unsubscribe();
			} catch (listenerCleanupFailure) {
				listenerCleanupFailures.push(listenerCleanupFailure);
			}
			try {
				unsubscribeAgentEvents?.();
			} catch (listenerCleanupFailure) {
				listenerCleanupFailures.push(listenerCleanupFailure);
			}

			if (primaryFailure !== undefined) {
				if (listenerCleanupFailures.length > 0) {
					throw new Error(
						`${sanitizeAnsteelFailureReason(primaryFailure)}; listener cleanup also failed: ${listenerCleanupFailures
							.map(sanitizeAnsteelFailureReason)
							.join("; ")}`,
						{ cause: primaryFailure },
					);
				}
				throw primaryFailure;
			}
			if (listenerCleanupFailures.length > 0) {
				if (listenerCleanupFailures.length === 1) throw listenerCleanupFailures[0];
				throw new Error(
					listenerCleanupFailures.map(sanitizeAnsteelFailureReason).join("; listener cleanup also failed: "),
				);
			}

			return rawAssistantText(assistantMessages.at(-1)) ?? "";
		},
		...(source.abort ? { abort: () => source.abort!() } : {}),
		dispose: () => source.dispose(),
		getLastStageAudit: () => ({ events: lastStageAudit.events.map((event) => ({ ...event })) }),
	};
}

export interface AnsteelToolBudget {
	reset: () => void;
	beforeToolCall: (toolName: string, args: unknown) => { block: true; reason: string } | undefined;
	getStageFailureReason: () => string | undefined;
	recordBlockedToolCall: (reason: string) => void;
}

/** Enforces bounded, evidence-oriented tool use for one role stage. */
export function createAnsteelToolBudget(maxToolCallsPerStage: number): AnsteelToolBudget {
	const maxToolCalls = normalizeAnsteelMaxToolCallsPerStage(maxToolCallsPerStage);
	let usedToolCalls = 0;
	let stageFailureReason: string | undefined;
	const blockStage = (reason: string): { block: true; reason: string } => {
		stageFailureReason ??= reason;
		return { block: true, reason: stageFailureReason };
	};

	return {
		reset: () => {
			usedToolCalls = 0;
			stageFailureReason = undefined;
		},
		getStageFailureReason: () => stageFailureReason,
		recordBlockedToolCall: (reason) => {
			stageFailureReason ??= reason;
		},
		beforeToolCall: (toolName, args) => {
			if (stageFailureReason) return { block: true, reason: stageFailureReason };
			if (usedToolCalls >= maxToolCalls) {
				return blockStage(
					`Ansteel stage tool budget of ${maxToolCalls} executions is exhausted. Provide the evidence-labelled conclusion without requesting more tools.`,
				);
			}

			usedToolCalls++;
			if (toolName === "bash") {
				const timeout = isRecord(args) ? args.timeout : undefined;
				if (
					typeof timeout !== "number" ||
					!Number.isFinite(timeout) ||
					timeout <= 0 ||
					timeout > ANSTEEL_MAX_BASH_TIMEOUT_SECONDS
				) {
					return blockStage(
						`Ansteel bash requires an explicit timeout of at most ${ANSTEEL_MAX_BASH_TIMEOUT_SECONDS} seconds.`,
					);
				}
			}
			return undefined;
		},
	};
}

function parseRoleTools(role: AnsteelRole, value: unknown): AnsteelReviewTool[] {
	if (value === undefined) return [...DEFAULT_ROLE_TOOLS[role]];
	if (!Array.isArray(value) || value.some((tool) => typeof tool !== "string")) {
		throw new AnsteelGovernanceSetupError(
			`Ansteel role ${role} tools must be an array of tool names`,
			"configuration",
			role,
		);
	}

	const allowed = new Set<string>(ANSTEEL_REVIEW_TOOLS);
	const tools = value.map((tool) => {
		if (!allowed.has(tool)) {
			throw new AnsteelGovernanceSetupError(`Ansteel role ${role} cannot use tool ${tool}`, "configuration", role);
		}
		return tool as AnsteelReviewTool;
	});

	if (role === "qa-engineer" && tools.includes("bash")) {
		throw new AnsteelGovernanceSetupError("Ansteel QA cannot use bash", "configuration", role);
	}

	return [...new Set(tools)];
}

function parseRoleThinkingLevel(role: AnsteelRole, value: unknown): ThinkingLevel | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !ANSTEEL_THINKING_LEVELS.includes(value as ThinkingLevel)) {
		throw new AnsteelGovernanceSetupError(
			`Ansteel role ${role} thinkingLevel must be one of ${ANSTEEL_THINKING_LEVELS.join(", ")}`,
			"configuration",
			role,
		);
	}
	return value as ThinkingLevel;
}

function parseRoleConfig(role: AnsteelRole, value: unknown): AnsteelRoleConfig {
	if (!isRecord(value)) {
		throw new AnsteelGovernanceSetupError(`Ansteel role ${role} must be an object`, "configuration", role);
	}
	if (typeof value.model !== "string" || value.model.trim().length === 0) {
		throw new AnsteelGovernanceSetupError(
			`Ansteel role ${role} requires an explicit provider/model`,
			"configuration",
			role,
		);
	}

	return {
		model: value.model,
		tools: parseRoleTools(role, value.tools),
		thinkingLevel: parseRoleThinkingLevel(role, value.thinkingLevel),
	};
}

function normalizeAnsteelStageTimeoutMs(value: unknown): number {
	const timeoutMs = value === undefined ? ANSTEEL_DEFAULT_STAGE_TIMEOUT_MS : value;
	if (
		typeof timeoutMs !== "number" ||
		!Number.isInteger(timeoutMs) ||
		timeoutMs <= 0 ||
		timeoutMs > ANSTEEL_MAX_STAGE_TIMEOUT_MS
	) {
		throw new Error(
			`Ansteel stageTimeoutMs must be an integer between 1 and ${ANSTEEL_MAX_STAGE_TIMEOUT_MS} milliseconds`,
		);
	}
	return timeoutMs;
}

function normalizeAnsteelMaxToolCallsPerStage(value: unknown): number {
	const maxToolCalls = value === undefined ? ANSTEEL_DEFAULT_MAX_TOOL_CALLS_PER_STAGE : value;
	if (
		typeof maxToolCalls !== "number" ||
		!Number.isInteger(maxToolCalls) ||
		maxToolCalls <= 0 ||
		maxToolCalls > ANSTEEL_MAX_TOOL_CALLS_PER_STAGE
	) {
		throw new Error(
			`Ansteel maxToolCallsPerStage must be an integer between 1 and ${ANSTEEL_MAX_TOOL_CALLS_PER_STAGE}`,
		);
	}
	return maxToolCalls;
}

interface ParseAnsteelConfigOptions {
	defaultReportDirectory: string;
	resolveReportDirectory: (reportDirectory: string) => string;
	source: string;
}

function parseAnsteelConfig(value: unknown, options: ParseAnsteelConfigOptions): AnsteelConfig {
	if (!isRecord(value)) {
		throw new AnsteelGovernanceSetupError(`${options.source} must be a JSON object`, "configuration");
	}
	if (value.roles !== undefined && !isRecord(value.roles)) {
		throw new AnsteelGovernanceSetupError("Ansteel config roles must be an object", "configuration");
	}
	if (value.reportDirectory !== undefined && typeof value.reportDirectory !== "string") {
		throw new AnsteelGovernanceSetupError("Ansteel config reportDirectory must be a string", "configuration");
	}
	let stageTimeoutMs: number;
	let maxToolCallsPerStage: number;
	try {
		stageTimeoutMs = normalizeAnsteelStageTimeoutMs(value.stageTimeoutMs);
		maxToolCallsPerStage = normalizeAnsteelMaxToolCallsPerStage(value.maxToolCallsPerStage);
	} catch (error) {
		throw new AnsteelGovernanceSetupError(sanitizeAnsteelFailureReason(error), "configuration");
	}

	const roleSettings = value.roles ?? {};
	return {
		roles: {
			"tech-lead": parseRoleConfig("tech-lead", roleSettings["tech-lead"]),
			"staff-engineer": parseRoleConfig("staff-engineer", roleSettings["staff-engineer"]),
			"qa-engineer": parseRoleConfig("qa-engineer", roleSettings["qa-engineer"]),
		},
		reportDirectory:
			value.reportDirectory === undefined
				? options.defaultReportDirectory
				: options.resolveReportDirectory(value.reportDirectory),
		stageTimeoutMs,
		maxToolCallsPerStage,
	};
}

export function getAnsteelDefaultReportDirectory(cwd: string): string {
	return resolvePath(join(cwd, ".pi", "ansteel-reports"));
}

function resolveAnsteelReportDirectory(cwd: string, reportDirectory: string): string {
	const resolvedReportDirectory = resolvePath(reportDirectory, cwd);
	if (getCwdRelativePath(resolvedReportDirectory, cwd) === undefined) {
		throw new AnsteelGovernanceSetupError(
			"Ansteel reportDirectory must stay inside the reviewed project",
			"configuration",
		);
	}
	return resolvedReportDirectory;
}

/** Load mandatory project-local role settings from .pi/ansteel.json. */
export function loadAnsteelConfig(cwd: string): AnsteelConfig {
	const configPath = join(cwd, ".pi", "ansteel.json");
	const defaultReportDirectory = getAnsteelDefaultReportDirectory(cwd);
	if (!existsSync(configPath)) {
		throw new AnsteelGovernanceSetupError(`Ansteel governance requires ${configPath}`, "configuration");
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf-8"));
	} catch (error) {
		throw new AnsteelGovernanceSetupError(
			`Failed to parse ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
			"configuration",
		);
	}
	return parseAnsteelConfig(parsed, {
		defaultReportDirectory,
		resolveReportDirectory: (reportDirectory) => resolveAnsteelReportDirectory(cwd, reportDirectory),
		source: `Ansteel config ${configPath}`,
	});
}

function formatReportTimestamp(date: Date): string {
	const pad = (value: number): string => String(value).padStart(2, "0");
	return [
		date.getUTCFullYear(),
		pad(date.getUTCMonth() + 1),
		pad(date.getUTCDate()),
		pad(date.getUTCHours()),
		pad(date.getUTCMinutes()),
		pad(date.getUTCSeconds()),
	].join("-");
}

function reportTopicSlug(topic: string): string {
	const slug = topic
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return slug || "review";
}

/** Persist the complete, unedited discussion transcript as a Markdown report. */
export function writeAnsteelReport(options: WriteAnsteelReportOptions): string {
	mkdirSync(options.reportDirectory, { recursive: true });
	const timestamp = formatReportTimestamp(options.now ?? new Date());
	const baseName = `ansteel-${timestamp}-${reportTopicSlug(options.topic)}`;
	let reportPath = join(options.reportDirectory, `${baseName}.md`);
	let sequence = 2;
	while (existsSync(reportPath)) {
		reportPath = join(options.reportDirectory, `${baseName}-${sequence}.md`);
		sequence++;
	}

	writeFileSync(reportPath, options.markdown, "utf-8");
	return reportPath;
}

function sanitizeAnsteelFailureReason(error: unknown): string {
	return formatFailureReason(error)
		.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
		.replace(/\bsk-[A-Za-z0-9._-]+\b/g, "[REDACTED]")
		.replace(/\b(api[-_ ]?key|secret|token)\s*[:=]\s*[^\s,;]+/gi, "$1: [REDACTED]")
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim()
		.slice(0, 500);
}

/** Create a failure record when mandatory governance cannot be constructed. */
export function createAnsteelSetupFailureMarkdown(options: CreateAnsteelSetupFailureMarkdownOptions): string {
	const setupError = options.error instanceof AnsteelGovernanceSetupError ? options.error : undefined;
	const role = setupError?.role ?? "configuration";
	const phase = setupError?.phase ?? "configuration";
	const configuredModels = options.config
		? ANSTEEL_ROLES.map((configuredRole) => `- ${configuredRole}: ${options.config!.roles[configuredRole].model}`)
		: ["- Unavailable: configuration could not be parsed or loaded."];

	return `${[
		`# Ansteel Engineering Review: ${options.topic}`,
		"## Status",
		"- Result: REJECTED",
		"- Governance gate: setup rejected",
		`- Failed role: ${role}`,
		`- Failed phase: ${phase}`,
		`- Reason: ${sanitizeAnsteelFailureReason(options.error)}`,
		"## Required Role Models",
		...configuredModels,
		"- Requirement: Tech Lead, Staff Engineer, and QA Engineer must use three distinct configured provider/model values.",
	].join("\n\n")}\n`;
}

function parseModelReference(reference: string): AnsteelModelReference {
	const separator = reference.indexOf("/");
	if (separator <= 0 || separator === reference.length - 1) {
		throw new Error(`Ansteel model reference must use provider/model form: ${reference}`);
	}

	return {
		provider: reference.slice(0, separator),
		id: reference.slice(separator + 1),
	};
}

/**
 * Runs the policy coordinator against independently-created role sessions.
 * The caller owns the SDK-specific construction of each session.
 */
export async function runAnsteelProjectReview<TModel extends AnsteelModelReference>(
	options: RunAnsteelProjectReviewOptions<TModel>,
): Promise<AnsteelProjectReviewResult<TModel>> {
	const config =
		options.config === undefined
			? loadAnsteelConfig(options.cwd)
			: parseAnsteelConfig(options.config, {
					defaultReportDirectory: getAnsteelDefaultReportDirectory(options.cwd),
					resolveReportDirectory: (reportDirectory) => resolveAnsteelReportDirectory(options.cwd, reportDirectory),
					source: "Ansteel config",
				});
	const roleModels = {} as Record<AnsteelRole, TModel>;
	const sessions = new Map<AnsteelRole, AnsteelRoleSession>();
	let reviewResult: AnsteelProjectReviewResult<TModel> | undefined;
	let primaryError: unknown;
	let reviewFailed = false;

	try {
		for (const role of ANSTEEL_ROLES) {
			const roleConfig = config.roles[role];
			let reference: AnsteelModelReference;
			try {
				reference = parseModelReference(roleConfig.model);
			} catch (error) {
				throw new AnsteelGovernanceSetupError(sanitizeAnsteelFailureReason(error), "model-resolution", role);
			}
			const configuredModel = options.resolveModel(reference.provider, reference.id);
			if (!configuredModel) {
				throw new AnsteelGovernanceSetupError(
					`Ansteel model is unavailable for ${role}: ${roleConfig.model}`,
					"model-resolution",
					role,
				);
			}
			roleModels[role] = configuredModel;
		}

		const assignedRoles = new Map<string, AnsteelRole>();
		for (const role of ANSTEEL_ROLES) {
			const model = roleModels[role];
			const reference = `${model.provider}/${model.id}`;
			const existingRole = assignedRoles.get(reference);
			if (existingRole) {
				throw new AnsteelGovernanceSetupError(
					`Ansteel governance requires distinct role models: ${role} duplicates ${existingRole} (${reference})`,
					"model-resolution",
					role,
				);
			}
			assignedRoles.set(reference, role);
		}

		for (const role of ANSTEEL_ROLES) {
			const roleConfig = config.roles[role];
			try {
				sessions.set(
					role,
					await options.createRoleSession({
						role,
						model: roleModels[role],
						tools: roleConfig.tools,
						thinkingLevel: roleConfig.thinkingLevel,
						cwd: options.cwd,
						maxToolCallsPerStage: config.maxToolCallsPerStage ?? ANSTEEL_DEFAULT_MAX_TOOL_CALLS_PER_STAGE,
					}),
				);
			} catch (error) {
				throw new AnsteelGovernanceSetupError(sanitizeAnsteelFailureReason(error), "session-construction", role);
			}
		}

		const discussion = await runAnsteelDiscussion({
			topic: options.topic,
			stageTimeoutMs: config.stageTimeoutMs,
			maxToolCallsPerStage: config.maxToolCallsPerStage,
			runRole: async ({ role, prompt }) => {
				const session = sessions.get(role);
				if (!session) throw new Error(`Ansteel role session is missing: ${role}`);
				return await session.prompt(prompt);
			},
			abortRole: ({ role }) => sessions.get(role)?.abort?.(),
			getStageAudit: ({ role }) => sessions.get(role)?.getLastStageAudit?.(),
		});

		reviewResult = { ...discussion, roleModels };
	} catch (error) {
		primaryError = error;
		reviewFailed = true;
	}

	const cleanupFailures = await disposeAnsteelRoleSessions(sessions);
	if (reviewFailed) {
		throw primaryError;
	}
	if (!reviewResult) {
		throw new Error("Ansteel review finished without a result");
	}

	return withCleanupFailures(reviewResult, cleanupFailures);
}

const CONFIDENCE_INSTRUCTIONS = [
	"Label every factual claim L1, L2, L3, or L4.",
	"L1 requires concrete evidence.",
	"L2 requires a stated technical basis.",
	"L3 requires a concrete verification method.",
	"L4 requires an explicit statement of what is unknown and no conclusion.",
].join(" ");

const ISSUE_LEDGER_INSTRUCTIONS = [
	"When raising a challenge, put every required change on its own line as `ISSUE: <ID>` using an uppercase ID such as STAFF-1 or QA-1.",
	"Each ISSUE marker must be a bare ASCII line with no Markdown formatting and no leading or trailing whitespace.",
	"State evidence, impact, and the acceptance condition below each issue.",
	"When there are no required changes, put exactly `NO ISSUES` on its own line.",
].join(" ");

const ROLE_INSTRUCTIONS: Record<AnsteelRole, string> = {
	"tech-lead": [
		"You are the Tech Lead and architect in an evidence-first engineering review.",
		"Publish a complete architecture, respond to every open challenge, verify disputed claims, and prioritize risks.",
		"An architecture revision must be a complete replacement architecture and must include one exact `RESOLUTION: <ID> | RESOLVED` line for every open challenge ID.",
		CONFIDENCE_INSTRUCTIONS,
	].join("\n"),
	"staff-engineer": [
		"You are the Staff Engineer in an evidence-first engineering review.",
		"Challenge implementation feasibility, interfaces, dependencies, sequencing, and operational cost without hiding uncertainty.",
		CONFIDENCE_INSTRUCTIONS,
		ISSUE_LEDGER_INSTRUCTIONS,
		"In verification and final sign-off stages end with exactly VERDICT: APPROVE or VERDICT: REJECT. A rejected verification must also add at least one new ISSUE line.",
	].join("\n"),
	"qa-engineer": [
		"You are the QA Engineer in an evidence-first engineering review and have veto authority.",
		"Look for counterexamples, missing evidence, unsafe assumptions, and untested behavior.",
		CONFIDENCE_INSTRUCTIONS,
		ISSUE_LEDGER_INSTRUCTIONS,
		"In verification and final sign-off stages end with exactly VERDICT: APPROVE or VERDICT: REJECT. A rejected verification must also add at least one new ISSUE line.",
	].join("\n"),
};

const STAGE_INSTRUCTIONS: Record<AnsteelDiscussionStage, string> = {
	architecture:
		"Publish the complete initial architecture: boundary, constraints, components, data/control flow, failure handling, evidence plan, and acceptance criteria.",
	"staff-critique":
		"Independently challenge the initial architecture for implementation feasibility. Do not assume the architecture is correct.",
	"qa-critique":
		"Independently challenge the same initial architecture for safety, testability, evidence gaps, and counterexamples. Do not assume the architecture is correct.",
	"architecture-revision":
		"Publish a complete revised architecture that responds to every open challenge in the supplied ledger. Do not silently discard an issue.",
	"staff-verification":
		"Verify the revised architecture's implementation feasibility against the supplied architecture version and ledger. End with the required explicit verdict marker.",
	"qa-verification":
		"Verify the revised architecture's safety, testability, and evidence against the supplied architecture version and ledger. End with the required explicit verdict marker.",
	consensus:
		"Produce the final consensus. Separate verified conclusions, unresolved risks, and required follow-up work.",
	"staff-sign-off":
		"Review the Tech Lead consensus in the transcript. It is immutable: do not rewrite or replace it. End with the required explicit verdict marker.",
	"qa-sign-off":
		"Review the Tech Lead consensus in the transcript after Staff Engineer sign-off. It is immutable: do not rewrite or replace it. End with the required explicit verdict marker.",
};

function formatTranscript(transcript: readonly AnsteelTranscriptEntry[]): string {
	if (transcript.length === 0) return "No prior discussion.";

	return transcript
		.map((entry, index) => {
			const round = entry.round === undefined ? "" : ` / round ${entry.round}`;
			return `### ${index + 1}. ${entry.role} / ${entry.stage}${round}\n\n${entry.response}`;
		})
		.join("\n\n");
}

function formatChallengeLedger(challengeLedger: readonly AnsteelChallengeLedgerEntry[]): string {
	if (challengeLedger.length === 0) return "No recorded challenge IDs.";

	return challengeLedger
		.map((challenge) => `- ${challenge.id} | ${challenge.raisedBy} | round ${challenge.round} | ${challenge.status}`)
		.join("\n");
}

interface BuildRolePromptOptions {
	round?: number;
	challengeLedger?: readonly AnsteelChallengeLedgerEntry[];
	maxToolCallsPerStage?: number;
}

function buildRolePrompt(
	role: AnsteelRole,
	stage: AnsteelDiscussionStage,
	topic: string,
	transcript: readonly AnsteelTranscriptEntry[],
	options: BuildRolePromptOptions = {},
): string {
	return [
		ROLE_INSTRUCTIONS[role],
		`Review topic: ${topic}`,
		`Current stage: ${stage}. ${STAGE_INSTRUCTIONS[stage]}`,
		...(options.round === undefined
			? []
			: [`Architecture revision round: ${options.round} of ${ANSTEEL_MAX_ARCHITECTURE_REVISION_ROUNDS}.`]),
		...(options.challengeLedger === undefined
			? []
			: [`Challenge ledger:\n${formatChallengeLedger(options.challengeLedger)}`]),
		`Tool governance: execute at most ${options.maxToolCallsPerStage ?? ANSTEEL_DEFAULT_MAX_TOOL_CALLS_PER_STAGE} tools during this stage. Bash calls must set timeout to no more than ${ANSTEEL_MAX_BASH_TIMEOUT_SECONDS} seconds. A blocked tool request or exhausted budget terminates this stage and rejects the review; do not repeat it.`,
		"Visible prior discussion follows. Treat it as claims to verify, not established facts.",
		formatTranscript(transcript),
	].join("\n\n");
}

function isVerdictCandidate(line: string): boolean {
	const contentAfterMarkdownPrefix = line.replace(/^\s*(?:(?:[-+*]|\d+[.)]|#{1,6}|>)\s+)+/, "");
	return /\bVERDICT\s*:/i.test(line) || /^\s*VERDICT\s+(?:approve|reject|pending)\b/i.test(contentAfterMarkdownPrefix);
}

function getExplicitVerdict(response: string): "approved" | "rejected" | undefined {
	const verdictMarkers = response.split(/\r?\n/).filter(isVerdictCandidate);
	if (verdictMarkers.length !== 1) return undefined;
	if (verdictMarkers[0] === "VERDICT: APPROVE") return "approved";
	if (verdictMarkers[0] === "VERDICT: REJECT") return "rejected";
	return undefined;
}

function parseIssueIds(response: string): { ids: string[]; error?: string } {
	const lines = response.split(/\r?\n/);
	const issueLines = lines.filter((line) => line.startsWith("ISSUE:"));
	const hasNoIssuesMarker = lines.includes("NO ISSUES");
	if (issueLines.length === 0) {
		return hasNoIssuesMarker ? { ids: [] } : { ids: [], error: "must provide ISSUE lines or exactly NO ISSUES" };
	}
	if (hasNoIssuesMarker) return { ids: [], error: "cannot combine ISSUE lines with NO ISSUES" };

	const ids: string[] = [];
	for (const line of issueLines) {
		const match = /^ISSUE: ([A-Z][A-Z0-9-]{1,63})$/.exec(line);
		if (!match) return { ids: [], error: `has invalid issue marker: ${line}` };
		ids.push(match[1]);
	}
	return new Set(ids).size === ids.length ? { ids } : { ids: [], error: "contains duplicate issue IDs" };
}

function parseResolutionIds(response: string): { ids: string[]; error?: string } {
	const resolutionLines = response.split(/\r?\n/).filter((line) => line.startsWith("RESOLUTION:"));
	const ids: string[] = [];
	for (const line of resolutionLines) {
		const match = /^RESOLUTION: ([A-Z][A-Z0-9-]{1,63}) \| RESOLVED$/.exec(line);
		if (!match) return { ids: [], error: `has invalid resolution marker: ${line}` };
		ids.push(match[1]);
	}
	return new Set(ids).size === ids.length ? { ids } : { ids: [], error: "contains duplicate resolution IDs" };
}

function addChallengeIds(
	challengeLedger: AnsteelChallengeLedgerEntry[],
	raisedBy: "staff-engineer" | "qa-engineer",
	round: number,
	response: string,
	requireAtLeastOne = false,
): string | undefined {
	const parsed = parseIssueIds(response);
	if (parsed.error) return `${raisedBy} ${parsed.error}`;
	if (requireAtLeastOne && parsed.ids.length === 0) {
		return `${raisedBy} rejected the architecture without adding a new ISSUE line`;
	}
	for (const id of parsed.ids) {
		if (challengeLedger.some((challenge) => challenge.id === id)) {
			return `${raisedBy} reused challenge ID ${id}`;
		}
		challengeLedger.push({ id, raisedBy, round, status: "open" });
	}
	return undefined;
}

function resolveOpenChallenges(challengeLedger: AnsteelChallengeLedgerEntry[], response: string): string | undefined {
	const parsed = parseResolutionIds(response);
	if (parsed.error) return parsed.error;
	const openIds = challengeLedger.filter((challenge) => challenge.status === "open").map((challenge) => challenge.id);
	const unknownIds = parsed.ids.filter((id) => !openIds.includes(id));
	if (unknownIds.length > 0) return `responded to unknown or already closed challenge IDs: ${unknownIds.join(", ")}`;
	const missingIds = openIds.filter((id) => !parsed.ids.includes(id));
	if (missingIds.length > 0) return `did not answer open challenge IDs: ${missingIds.join(", ")}`;
	for (const challenge of challengeLedger) {
		if (challenge.status === "open") challenge.status = "resolved";
	}
	return undefined;
}

function isBlankRoleResponse(response: string): boolean {
	return response.trim().length === 0;
}

function formatBlankResponseStopReason(role: AnsteelRole, stage: AnsteelDiscussionStage): string {
	return `${role} / ${stage} returned an empty or whitespace-only response. The review stopped before consensus could be accepted.`;
}

function formatFailureReason(error: unknown): string {
	try {
		if (error instanceof Error) {
			const message = error.message;
			if (typeof message === "string" && message) return message;
			const name = error.name;
			if (typeof name === "string" && name) return name;
		} else {
			const reason = String(error);
			if (reason) return reason;
		}
	} catch {
		// Error formatting must never interrupt a cleanup pass or replace the primary failure.
	}
	return "Unknown role failure";
}

async function disposeAnsteelRoleSessions(
	sessions: ReadonlyMap<AnsteelRole, AnsteelRoleSession>,
): Promise<AnsteelSessionCleanupFailure[]> {
	const cleanupFailures: AnsteelSessionCleanupFailure[] = [];
	for (const role of ANSTEEL_ROLES) {
		const session = sessions.get(role);
		if (!session) continue;
		try {
			await session.dispose();
		} catch (error) {
			cleanupFailures.push({ role, reason: sanitizeAnsteelFailureReason(error) });
		}
	}
	return cleanupFailures;
}

function withCleanupFailures<TModel extends AnsteelModelReference>(
	result: AnsteelProjectReviewResult<TModel>,
	cleanupFailures: readonly AnsteelSessionCleanupFailure[],
): AnsteelProjectReviewResult<TModel> {
	if (cleanupFailures.length === 0) return result;

	const cleanupWarning = cleanupFailures.map(({ role, reason }) => `- ${role}: ${reason}`).join("\n");
	return {
		...result,
		cleanupFailures: [...cleanupFailures],
		markdown: `${result.markdown}${result.markdown.endsWith("\n") ? "\n" : "\n\n"}## Session Cleanup Failures\n\n${cleanupWarning}\n`,
	};
}

function formatStageFailureStopReason(failure: AnsteelDiscussionFailure): string {
	return `${failure.role} / ${failure.stage} failed: ${failure.reason}. The review stopped before consensus could be accepted.`;
}

function getStageFailureTerminationReason(failure: AnsteelDiscussionFailure): AnsteelTerminationReason {
	return failure.timeoutMs === undefined ? "stage-failure" : "stage-timeout";
}

async function abortTimedOutAnsteelRole(
	abortRole: RunAnsteelDiscussionOptions["abortRole"],
	call: AnsteelRoleCall,
): Promise<void> {
	if (!abortRole) return;
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.resolve().then(() => abortRole(call)),
			new Promise<void>((resolve) => {
				timeoutHandle = setTimeout(resolve, ANSTEEL_ABORT_GRACE_MS);
			}),
		]);
	} catch {
		// The configured stage timeout remains the governing failure.
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
	}
}

function formatAuditValue(value: string): string {
	return value.replace(/[\r\n]/g, " ").replace(/[^a-zA-Z0-9_.:-]/g, "_");
}

function formatStageAudits(stageAudits: readonly AnsteelStageAudit[]): string {
	if (stageAudits.length === 0) return "No stage event audit was available.";

	return stageAudits
		.map((audit, index) => {
			const round = audit.round === undefined ? "" : ` / round ${audit.round}`;
			const events =
				audit.events.length === 0
					? "- No lifecycle events were captured."
					: audit.events
							.map((event) => {
								const detail = [
									event.toolName ? `: ${formatAuditValue(event.toolName)}` : "",
									event.stopReason ? `; stop=${formatAuditValue(event.stopReason)}` : "",
									event.isError === undefined ? "" : `; error=${event.isError}`,
									event.durationMs === undefined ? "" : `; duration=${event.durationMs}ms`,
								].join("");
								return `- ${event.type}${detail}; elapsed=${event.elapsedMs}ms`;
							})
							.join("\n");
			return `### ${index + 1}. ${audit.role} / ${audit.stage}${round}\n\n${events}`;
		})
		.join("\n\n");
}

function createMarkdown(
	topic: string,
	verdict: AnsteelDiscussionResult["verdict"],
	transcript: readonly AnsteelTranscriptEntry[],
	stageAudits: readonly AnsteelStageAudit[],
	challengeLedger: readonly AnsteelChallengeLedgerEntry[],
	revisionRounds: readonly AnsteelRevisionRound[],
	consensus: string | undefined,
	stopReason?: string,
	failure?: AnsteelDiscussionFailure,
	terminationReason?: AnsteelTerminationReason,
): string {
	const status =
		verdict === "approved"
			? "Architecture passed independent Staff and QA verification, then received final Staff Engineer and QA Engineer sign-off"
			: (stopReason ?? "A required governance sign-off did not explicitly approve");
	const sections = [
		`# Ansteel Engineering Review: ${topic}`,
		"## Status",
		`- Result: ${verdict.toUpperCase()}`,
		`- Governance status: ${status}`,
		...(stopReason ? [`- Stop reason: ${stopReason}`] : []),
		...(terminationReason ? [`- Termination reason: ${terminationReason}`] : []),
		"- Governance gate: the architecture must pass independent Staff and QA verification before Tech Lead consensus requires final Staff Engineer and QA Engineer sign-off.",
		"- Confidence boundary: role separation alone is not cross-model verification. L1 claims require cited tool, file, test, or source evidence.",
		...(failure
			? [
					"## Stage Failure",
					`- Failed role: ${failure.role}`,
					`- Failed stage: ${failure.stage}`,
					`- Reason: ${failure.reason}`,
					...(failure.timeoutMs === undefined ? [] : [`- Timeout: ${failure.timeoutMs}ms`]),
				]
			: []),
		"## Stage Audit Trail",
		formatStageAudits(stageAudits),
		"## Challenge Ledger",
		formatChallengeLedger(challengeLedger),
		"## Architecture Revision Rounds",
		...(revisionRounds.length === 0
			? ["- No completed architecture revision round."]
			: revisionRounds.map(
					(round) =>
						`- Round ${round.round}: Staff ${round.staffVerdict.toUpperCase()}, QA ${round.qaVerdict.toUpperCase()}, ${round.outcome}`,
				)),
		"## Full Transcript",
		formatTranscript(transcript),
	];

	if (consensus) {
		sections.push("## Tech Lead Consensus", consensus);
	}

	return `${sections.join("\n\n")}\n`;
}

export async function runAnsteelDiscussion(options: RunAnsteelDiscussionOptions): Promise<AnsteelDiscussionResult> {
	const topic = options.topic.trim();
	if (!topic) {
		throw new Error("Ansteel discussion requires a review topic");
	}
	const stageTimeoutMs = normalizeAnsteelStageTimeoutMs(options.stageTimeoutMs);
	const maxToolCallsPerStage = normalizeAnsteelMaxToolCallsPerStage(options.maxToolCallsPerStage);

	const transcript: AnsteelTranscriptEntry[] = [];
	const stageAudits: AnsteelStageAudit[] = [];
	const challengeLedger: AnsteelChallengeLedgerEntry[] = [];
	const revisionRounds: AnsteelRevisionRound[] = [];
	type StageResult = { response: string } | { failure: AnsteelDiscussionFailure };
	type TimedRoleResult =
		| { kind: "response"; response: string }
		| { kind: "failure"; error: unknown }
		| { kind: "timeout" };
	interface RunStageOptions {
		round?: number;
		context?: readonly AnsteelTranscriptEntry[];
		challengeLedger?: readonly AnsteelChallengeLedgerEntry[];
	}
	const runStage = async (
		role: AnsteelRole,
		stage: AnsteelDiscussionStage,
		stageOptions: RunStageOptions = {},
	): Promise<StageResult> => {
		const stageStartedAt = Date.now();
		const prompt = buildRolePrompt(role, stage, topic, stageOptions.context ?? transcript, {
			round: stageOptions.round,
			challengeLedger: stageOptions.challengeLedger,
			maxToolCallsPerStage,
		});
		const call: AnsteelRoleCall = {
			role,
			stage,
			prompt,
			...(stageOptions.round === undefined ? {} : { round: stageOptions.round }),
		};
		const captureStageAudit = (terminalEvent?: AnsteelStageAuditEvent): void => {
			let auditEvents: AnsteelStageAuditEvent[] | undefined;
			try {
				const audit = options.getStageAudit?.(call);
				if (audit) auditEvents = audit.events.map((event) => ({ ...event }));
			} catch {
				// Audit collection must not turn an otherwise governed failure into an unarchived crash.
			}
			if (!auditEvents && !terminalEvent) return;
			stageAudits.push({
				role,
				stage,
				...(stageOptions.round === undefined ? {} : { round: stageOptions.round }),
				events: [...(auditEvents ?? []), ...(terminalEvent ? [{ ...terminalEvent }] : [])],
			});
		};
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		const roleResult: Promise<TimedRoleResult> = Promise.resolve()
			.then(() => options.runRole(call))
			.then(
				(response) => ({ kind: "response", response }),
				(error) => ({ kind: "failure", error }),
			);
		const timeoutResult = new Promise<TimedRoleResult>((resolve) => {
			timeoutHandle = setTimeout(() => resolve({ kind: "timeout" }), stageTimeoutMs);
		});
		const timedResult = await Promise.race([roleResult, timeoutResult]);
		if (timeoutHandle) clearTimeout(timeoutHandle);
		if (timedResult.kind === "timeout") {
			await abortTimedOutAnsteelRole(options.abortRole, call);
			captureStageAudit({ type: "stage-timeout", elapsedMs: elapsedSince(stageStartedAt) });
			return {
				failure: {
					role,
					stage,
					reason: `Stage exceeded the configured timeout of ${stageTimeoutMs}ms`,
					timeoutMs: stageTimeoutMs,
				},
			};
		}
		if (timedResult.kind === "failure") {
			captureStageAudit();
			return { failure: { role, stage, reason: sanitizeAnsteelFailureReason(timedResult.error) } };
		}
		const response = timedResult.response;
		captureStageAudit();
		transcript.push({
			role,
			stage,
			prompt,
			response,
			...(stageOptions.round === undefined ? {} : { round: stageOptions.round }),
		});
		return { response };
	};
	const reject = (
		stopReason?: string,
		failure?: AnsteelDiscussionFailure,
		consensus?: string,
		terminationReason?: AnsteelTerminationReason,
	): AnsteelDiscussionResult => ({
		topic,
		verdict: "rejected",
		transcript,
		stageAudits,
		challengeLedger,
		revisionRounds,
		...(consensus ? { consensus } : {}),
		...(failure ? { failure } : {}),
		...(terminationReason ? { terminationReason } : {}),
		markdown: createMarkdown(
			topic,
			"rejected",
			transcript,
			stageAudits,
			challengeLedger,
			revisionRounds,
			consensus,
			stopReason,
			failure,
			terminationReason,
		),
	});
	const runRequiredStage = async (
		role: AnsteelRole,
		stage: AnsteelDiscussionStage,
		stageOptions: RunStageOptions = {},
	): Promise<{ response: string; entry: AnsteelTranscriptEntry } | { rejection: AnsteelDiscussionResult }> => {
		const stageResult = await runStage(role, stage, stageOptions);
		if ("failure" in stageResult) {
			return {
				rejection: reject(
					formatStageFailureStopReason(stageResult.failure),
					stageResult.failure,
					undefined,
					getStageFailureTerminationReason(stageResult.failure),
				),
			};
		}
		if (isBlankRoleResponse(stageResult.response)) {
			return {
				rejection: reject(formatBlankResponseStopReason(role, stage), undefined, undefined, "blank-response"),
			};
		}
		const entry = transcript.at(-1);
		if (!entry) throw new Error(`Ansteel ${role} / ${stage} completed without a transcript entry`);
		return { response: stageResult.response, entry };
	};

	const architectureResult = await runRequiredStage("tech-lead", "architecture");
	if ("rejection" in architectureResult) return architectureResult.rejection;
	const initialArchitecture = architectureResult.entry;

	const staffCritiqueResult = await runRequiredStage("staff-engineer", "staff-critique", {
		context: [initialArchitecture],
	});
	if ("rejection" in staffCritiqueResult) return staffCritiqueResult.rejection;
	const staffCritiqueError = addChallengeIds(challengeLedger, "staff-engineer", 0, staffCritiqueResult.response);
	if (staffCritiqueError) {
		return reject(staffCritiqueError, undefined, undefined, "invalid-challenge-ledger");
	}

	const qaCritiqueResult = await runRequiredStage("qa-engineer", "qa-critique", {
		context: [initialArchitecture],
	});
	if ("rejection" in qaCritiqueResult) return qaCritiqueResult.rejection;
	const qaCritiqueError = addChallengeIds(challengeLedger, "qa-engineer", 0, qaCritiqueResult.response);
	if (qaCritiqueError) {
		return reject(qaCritiqueError, undefined, undefined, "invalid-challenge-ledger");
	}

	let currentArchitecture = initialArchitecture;
	let revisionEvidence: AnsteelTranscriptEntry[] = [staffCritiqueResult.entry, qaCritiqueResult.entry];
	let architectureAccepted = false;

	for (let round = 1; round <= ANSTEEL_MAX_ARCHITECTURE_REVISION_ROUNDS; round++) {
		const architectureRevisionResult = await runRequiredStage("tech-lead", "architecture-revision", {
			round,
			context: [currentArchitecture, ...revisionEvidence],
			challengeLedger,
		});
		if ("rejection" in architectureRevisionResult) return architectureRevisionResult.rejection;
		const resolutionError = resolveOpenChallenges(challengeLedger, architectureRevisionResult.response);
		if (resolutionError) {
			return reject(
				`Architecture revision round ${round} ${resolutionError}`,
				undefined,
				undefined,
				"unanswered-challenge",
			);
		}
		currentArchitecture = architectureRevisionResult.entry;

		const verificationLedger = challengeLedger.map((challenge) => ({ ...challenge }));
		const verificationContext = [currentArchitecture];
		const staffVerificationResult = await runRequiredStage("staff-engineer", "staff-verification", {
			round,
			context: verificationContext,
			challengeLedger: verificationLedger,
		});
		if ("rejection" in staffVerificationResult) return staffVerificationResult.rejection;
		const staffVerdict = getExplicitVerdict(staffVerificationResult.response);
		if (!staffVerdict) {
			return reject(
				`staff-engineer / staff-verification did not provide the required exact verdict`,
				undefined,
				undefined,
				"invalid-verdict",
			);
		}

		const qaVerificationResult = await runRequiredStage("qa-engineer", "qa-verification", {
			round,
			context: verificationContext,
			challengeLedger: verificationLedger,
		});
		if ("rejection" in qaVerificationResult) return qaVerificationResult.rejection;
		const qaVerdict = getExplicitVerdict(qaVerificationResult.response);
		if (!qaVerdict) {
			return reject(
				`qa-engineer / qa-verification did not provide the required exact verdict`,
				undefined,
				undefined,
				"invalid-verdict",
			);
		}

		revisionEvidence = [];
		if (staffVerdict === "rejected") {
			const staffVerificationError = addChallengeIds(
				challengeLedger,
				"staff-engineer",
				round,
				staffVerificationResult.response,
				true,
			);
			if (staffVerificationError) {
				return reject(staffVerificationError, undefined, undefined, "invalid-challenge-ledger");
			}
			revisionEvidence.push(staffVerificationResult.entry);
		}
		if (qaVerdict === "rejected") {
			const qaVerificationError = addChallengeIds(
				challengeLedger,
				"qa-engineer",
				round,
				qaVerificationResult.response,
				true,
			);
			if (qaVerificationError) {
				return reject(qaVerificationError, undefined, undefined, "invalid-challenge-ledger");
			}
			revisionEvidence.push(qaVerificationResult.entry);
		}

		const outcome = staffVerdict === "approved" && qaVerdict === "approved" ? "approved" : "needs-revision";
		revisionRounds.push({ round, staffVerdict, qaVerdict, outcome });
		if (outcome === "approved") {
			architectureAccepted = true;
			break;
		}
		if (round === ANSTEEL_MAX_ARCHITECTURE_REVISION_ROUNDS) {
			return reject(
				`Architecture did not pass independent verification within the maximum of ${ANSTEEL_MAX_ARCHITECTURE_REVISION_ROUNDS} architecture revision rounds`,
				undefined,
				undefined,
				"max-revision-rounds-exhausted",
			);
		}
	}

	if (!architectureAccepted) {
		return reject(
			"Architecture did not reach an approved revision round",
			undefined,
			undefined,
			"max-revision-rounds-exhausted",
		);
	}

	const consensusResult = await runRequiredStage("tech-lead", "consensus");
	if ("rejection" in consensusResult) return consensusResult.rejection;
	const consensus = consensusResult.response;

	const finalSignOffStages: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage }> = [
		{ role: "staff-engineer", stage: "staff-sign-off" },
		{ role: "qa-engineer", stage: "qa-sign-off" },
	];
	for (const { role, stage } of finalSignOffStages) {
		const signOffResult = await runStage(role, stage);
		if ("failure" in signOffResult) {
			return reject(
				formatStageFailureStopReason(signOffResult.failure),
				signOffResult.failure,
				consensus,
				getStageFailureTerminationReason(signOffResult.failure),
			);
		}
		if (isBlankRoleResponse(signOffResult.response)) {
			return reject(formatBlankResponseStopReason(role, stage), undefined, consensus, "blank-response");
		}
		if (getExplicitVerdict(signOffResult.response) !== "approved") {
			return reject(
				`${role} / ${stage} did not provide the required explicit approval`,
				undefined,
				consensus,
				"final-sign-off-rejected",
			);
		}
	}

	return {
		topic,
		verdict: "approved",
		transcript,
		stageAudits,
		challengeLedger,
		revisionRounds,
		consensus,
		markdown: createMarkdown(topic, "approved", transcript, stageAudits, challengeLedger, revisionRounds, consensus),
	};
}
