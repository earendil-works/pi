import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCwdRelativePath, resolvePath } from "../utils/paths.ts";

export const ANSTEEL_ROLES = ["tech-lead", "staff-engineer", "qa-engineer"] as const;

export type AnsteelRole = (typeof ANSTEEL_ROLES)[number];

export const ANSTEEL_DISCUSSION_STAGES = [
	"scope",
	"proposal",
	"critique",
	"revision",
	"verification",
	"veto",
	"consensus",
	"staff-sign-off",
	"qa-sign-off",
] as const;

export type AnsteelDiscussionStage = (typeof ANSTEEL_DISCUSSION_STAGES)[number];

export interface AnsteelRoleCall {
	role: AnsteelRole;
	stage: AnsteelDiscussionStage;
	prompt: string;
}

export interface AnsteelTranscriptEntry extends AnsteelRoleCall {
	response: string;
}

export interface AnsteelDiscussionFailure {
	role: AnsteelRole;
	stage: AnsteelDiscussionStage;
	reason: string;
}

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
}

export interface AnsteelDiscussionResult {
	topic: string;
	verdict: "approved" | "rejected";
	transcript: AnsteelTranscriptEntry[];
	consensus?: string;
	failure?: AnsteelDiscussionFailure;
	cleanupFailures?: AnsteelSessionCleanupFailure[];
	markdown: string;
}

/** Maps a completed review verdict to the CLI's process outcome. */
export function getAnsteelReviewExitCode(verdict: AnsteelDiscussionResult["verdict"]): 0 | 1 {
	return verdict === "approved" ? 0 : 1;
}

export const ANSTEEL_REVIEW_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;

export type AnsteelReviewTool = (typeof ANSTEEL_REVIEW_TOOLS)[number];

export interface AnsteelRoleConfig {
	model: string;
	tools: AnsteelReviewTool[];
}

export interface AnsteelConfig {
	roles: Record<AnsteelRole, AnsteelRoleConfig>;
	reportDirectory: string;
}

export interface AnsteelModelReference {
	provider: string;
	id: string;
}

export interface AnsteelRoleSession {
	prompt: (text: string) => Promise<string>;
	dispose: () => void | Promise<void>;
}

/** The minimal AgentSession surface needed to capture a single raw assistant turn. */
export interface AnsteelRawTurnSessionSource {
	prompt: (text: string) => Promise<void>;
	subscribeToAssistantMessageEnd: (listener: (message: unknown) => void) => () => void;
	dispose: () => void | Promise<void>;
}

export interface CreateAnsteelRoleSessionOptions<TModel extends AnsteelModelReference> {
	role: AnsteelRole;
	model: TModel;
	tools: readonly AnsteelReviewTool[];
	cwd: string;
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

/**
 * Adapts a session so every review stage receives only the raw assistant text
 * emitted by that stage's prompt. Empty and aborted messages remain empty.
 */
export function createAnsteelRawTurnSession(source: AnsteelRawTurnSessionSource): AnsteelRoleSession {
	return {
		prompt: async (text) => {
			const assistantMessages: unknown[] = [];
			const unsubscribe = source.subscribeToAssistantMessageEnd((message) => {
				assistantMessages.push(message);
			});
			let promptFailed = false;
			let promptFailure: unknown;

			try {
				await source.prompt(text);
			} catch (error) {
				promptFailed = true;
				promptFailure = error;
			}

			try {
				unsubscribe();
			} catch (listenerCleanupFailure) {
				if (promptFailed) {
					throw new Error(
						`${formatFailureReason(promptFailure)}; listener cleanup also failed: ${formatFailureReason(listenerCleanupFailure)}`,
						{ cause: promptFailure },
					);
				}
				throw listenerCleanupFailure;
			}

			if (promptFailed) throw promptFailure;

			return rawAssistantText(assistantMessages.at(-1)) ?? "";
		},
		dispose: () => source.dispose(),
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
	};
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

function sanitizeAnsteelSetupFailureReason(error: unknown): string {
	return formatFailureReason(error)
		.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
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
		`- Reason: ${sanitizeAnsteelSetupFailureReason(options.error)}`,
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
				throw new AnsteelGovernanceSetupError(formatFailureReason(error), "model-resolution", role);
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
						cwd: options.cwd,
					}),
				);
			} catch (error) {
				throw new AnsteelGovernanceSetupError(formatFailureReason(error), "session-construction", role);
			}
		}

		const discussion = await runAnsteelDiscussion({
			topic: options.topic,
			runRole: async ({ role, prompt }) => {
				const session = sessions.get(role);
				if (!session) throw new Error(`Ansteel role session is missing: ${role}`);
				return await session.prompt(prompt);
			},
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

const ROLE_INSTRUCTIONS: Record<AnsteelRole, string> = {
	"tech-lead": [
		"You are the Tech Lead in an evidence-first engineering review.",
		"Define scope and acceptance criteria, verify disputed claims, and prioritize risks.",
		CONFIDENCE_INSTRUCTIONS,
	].join("\n"),
	"staff-engineer": [
		"You are the Staff Engineer in an evidence-first engineering review.",
		"Propose and revise an implementable solution without hiding uncertainty.",
		CONFIDENCE_INSTRUCTIONS,
		"Preserve unresolved L3 and L4 claims.",
		"In the final sign-off stage end with exactly VERDICT: APPROVE or VERDICT: REJECT.",
	].join("\n"),
	"qa-engineer": [
		"You are the QA Engineer in an evidence-first engineering review and have veto authority.",
		"Look for counterexamples, missing evidence, unsafe assumptions, and untested behavior.",
		CONFIDENCE_INSTRUCTIONS,
		"In the veto stage end with exactly VERDICT: APPROVE or VERDICT: REJECT.",
	].join("\n"),
};

const STAGE_INSTRUCTIONS: Record<AnsteelDiscussionStage, string> = {
	scope: "Define the review boundary, key questions, required evidence, and acceptance criteria.",
	proposal: "Produce an initial technical assessment and concrete recommendations for the review topic.",
	critique: "Challenge the proposed assessment. Identify evidence gaps, invalid assumptions, and missing tests.",
	revision: "Respond directly to QA's critique and revise the assessment. Do not silently discard unresolved issues.",
	verification: "Verify disputed claims against the available evidence and state what remains unverified.",
	veto: "Decide whether the revised assessment may proceed. End with the required explicit verdict marker.",
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
			return `### ${index + 1}. ${entry.role} / ${entry.stage}\n\n${entry.response}`;
		})
		.join("\n\n");
}

function buildRolePrompt(
	role: AnsteelRole,
	stage: AnsteelDiscussionStage,
	topic: string,
	transcript: readonly AnsteelTranscriptEntry[],
): string {
	return [
		ROLE_INSTRUCTIONS[role],
		`Review topic: ${topic}`,
		`Current stage: ${stage}. ${STAGE_INSTRUCTIONS[stage]}`,
		"Prior discussion follows. Treat it as claims to verify, not established facts.",
		formatTranscript(transcript),
	].join("\n\n");
}

function isQaVerdictCandidate(line: string): boolean {
	const contentAfterMarkdownPrefix = line.replace(/^\s*(?:(?:[-+*]|\d+[.)]|#{1,6}|>)\s+)+/, "");
	return /\bVERDICT\s*:/i.test(line) || /^\s*VERDICT\s+(?:approve|reject|pending)\b/i.test(contentAfterMarkdownPrefix);
}

function hasExplicitApproval(response: string): boolean {
	const verdictMarkers = response.split(/\r?\n/).filter(isQaVerdictCandidate);
	return verdictMarkers.length === 1 && verdictMarkers[0] === "VERDICT: APPROVE";
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
			cleanupFailures.push({ role, reason: formatFailureReason(error) });
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

function createMarkdown(
	topic: string,
	verdict: AnsteelDiscussionResult["verdict"],
	transcript: readonly AnsteelTranscriptEntry[],
	consensus: string | undefined,
	stopReason?: string,
	failure?: AnsteelDiscussionFailure,
): string {
	const status =
		verdict === "approved"
			? "Tech Lead consensus received Staff Engineer and QA Engineer final sign-off"
			: (stopReason ?? "A required governance sign-off did not explicitly approve");
	const sections = [
		`# Ansteel Engineering Review: ${topic}`,
		"## Status",
		`- Result: ${verdict.toUpperCase()}`,
		`- QA gate: ${status}`,
		...(stopReason ? [`- Stop reason: ${stopReason}`] : []),
		"- Governance gate: Tech Lead consensus requires final Staff Engineer and QA Engineer sign-off.",
		"- Confidence boundary: role separation alone is not cross-model verification. L1 claims require cited tool, file, test, or source evidence.",
		...(failure
			? [
					"## Stage Failure",
					`- Failed role: ${failure.role}`,
					`- Failed stage: ${failure.stage}`,
					`- Reason: ${failure.reason}`,
				]
			: []),
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

	const transcript: AnsteelTranscriptEntry[] = [];
	type StageResult = { response: string } | { failure: AnsteelDiscussionFailure };
	const runStage = async (role: AnsteelRole, stage: AnsteelDiscussionStage): Promise<StageResult> => {
		const prompt = buildRolePrompt(role, stage, topic, transcript);
		let response: string;
		try {
			response = await options.runRole({ role, stage, prompt });
		} catch (error) {
			return { failure: { role, stage, reason: formatFailureReason(error) } };
		}
		transcript.push({ role, stage, prompt, response });
		return { response };
	};
	const reject = (
		stopReason?: string,
		failure?: AnsteelDiscussionFailure,
		consensus?: string,
	): AnsteelDiscussionResult => ({
		topic,
		verdict: "rejected",
		transcript,
		...(consensus ? { consensus } : {}),
		...(failure ? { failure } : {}),
		markdown: createMarkdown(topic, "rejected", transcript, consensus, stopReason, failure),
	});
	const preVetoStages: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage }> = [
		{ role: "tech-lead", stage: "scope" },
		{ role: "staff-engineer", stage: "proposal" },
		{ role: "qa-engineer", stage: "critique" },
		{ role: "staff-engineer", stage: "revision" },
		{ role: "tech-lead", stage: "verification" },
	];

	for (const { role, stage } of preVetoStages) {
		const stageResult = await runStage(role, stage);
		if ("failure" in stageResult) {
			return reject(formatStageFailureStopReason(stageResult.failure), stageResult.failure);
		}
		const { response } = stageResult;
		if (isBlankRoleResponse(response)) {
			return reject(formatBlankResponseStopReason(role, stage));
		}
	}

	const vetoResult = await runStage("qa-engineer", "veto");
	if ("failure" in vetoResult) {
		return reject(formatStageFailureStopReason(vetoResult.failure), vetoResult.failure);
	}
	const { response: veto } = vetoResult;
	if (isBlankRoleResponse(veto)) {
		return reject(formatBlankResponseStopReason("qa-engineer", "veto"));
	}

	if (!hasExplicitApproval(veto)) {
		return reject();
	}

	const consensusResult = await runStage("tech-lead", "consensus");
	if ("failure" in consensusResult) {
		return reject(formatStageFailureStopReason(consensusResult.failure), consensusResult.failure);
	}
	const { response: consensus } = consensusResult;
	if (isBlankRoleResponse(consensus)) {
		return reject(formatBlankResponseStopReason("tech-lead", "consensus"));
	}

	const finalSignOffStages: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage }> = [
		{ role: "staff-engineer", stage: "staff-sign-off" },
		{ role: "qa-engineer", stage: "qa-sign-off" },
	];
	for (const { role, stage } of finalSignOffStages) {
		const signOffResult = await runStage(role, stage);
		if ("failure" in signOffResult) {
			return reject(formatStageFailureStopReason(signOffResult.failure), signOffResult.failure, consensus);
		}
		const { response } = signOffResult;
		if (isBlankRoleResponse(response)) {
			return reject(formatBlankResponseStopReason(role, stage), undefined, consensus);
		}
		if (!hasExplicitApproval(response)) {
			return reject(`${role} / ${stage} did not provide the required explicit approval`, undefined, consensus);
		}
	}

	return {
		topic,
		verdict: "approved",
		transcript,
		consensus,
		markdown: createMarkdown(topic, "approved", transcript, consensus),
	};
}
