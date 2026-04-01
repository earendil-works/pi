import { existsSync } from "node:fs";
import type { AssistantMessage, Message } from "@kennyfrc/mu-ai";
import { SessionManager } from "./session-manager.js";
import { loadThreadMessagesFromSessionFile } from "./tools/read-thread-session.js";

export type SpawnedAgentStatus = "running" | "completed" | "error" | "aborted" | "not_found" | "timed_out";

type SpawnedAgentRole = "child" | "worker" | "verifier";

export interface SpawnedAgentSummary {
	sessionId: string;
	sessionFile: string;
	effectiveModel: string;
	effectiveReasoning: string;
	role: SpawnedAgentRole;
	waited: boolean;
	status: SpawnedAgentStatus;
	stopReason?: string;
	text?: string;
	verificationStatus?: "PASS" | "FAIL";
	verificationIssues?: string[];
}

interface SpawnAgentDetailsLike {
	sessionId: string;
	sessionFile: string;
	effectiveModel: string;
	effectiveReasoning: string;
}

interface WaitAgentResultLike {
	sessionId: string;
	status: string;
	stopReason?: string;
	text?: string;
}

interface SpawnAgentTerminalResultLike {
	status: SpawnedAgentStatus;
	stopReason?: string;
	text?: string;
}

interface SpawnAgentVerificationReportLike {
	status: "PASS" | "FAIL";
	issues: string[];
}

interface SpawnAgentCompositeDetailsLike {
	worker?: SpawnAgentDetailsLike;
	workerResult?: SpawnAgentTerminalResultLike;
	verifier?: SpawnAgentDetailsLike;
	verifierResult?: SpawnAgentTerminalResultLike;
	verificationReport?: SpawnAgentVerificationReportLike;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isToolResultMessage(message: Message): message is Message & { toolName: string; details?: unknown } {
	return (
		message.role === "toolResult" &&
		isRecord(message) &&
		typeof (message as { toolName?: unknown }).toolName === "string"
	);
}

function isSpawnedAgentStatus(value: unknown): value is SpawnedAgentStatus {
	return (
		value === "running" ||
		value === "completed" ||
		value === "error" ||
		value === "aborted" ||
		value === "not_found" ||
		value === "timed_out"
	);
}

function readSpawnAgentDetails(details: unknown): SpawnAgentDetailsLike | null {
	if (!isRecord(details)) return null;
	if (typeof details.sessionId !== "string") return null;
	if (typeof details.sessionFile !== "string") return null;
	if (typeof details.effectiveModel !== "string") return null;
	if (typeof details.effectiveReasoning !== "string") return null;
	return {
		sessionId: details.sessionId,
		sessionFile: details.sessionFile,
		effectiveModel: details.effectiveModel,
		effectiveReasoning: details.effectiveReasoning,
	};
}

function readWaitAgentResults(details: unknown): WaitAgentResultLike[] {
	if (!isRecord(details) || !Array.isArray(details.results)) return [];
	const results: WaitAgentResultLike[] = [];
	for (const item of details.results) {
		if (!isRecord(item)) continue;
		if (typeof item.sessionId !== "string") continue;
		if (typeof item.status !== "string") continue;
		results.push({
			sessionId: item.sessionId,
			status: item.status,
			stopReason: typeof item.stopReason === "string" ? item.stopReason : undefined,
			text: typeof item.text === "string" ? item.text : undefined,
		});
	}
	return results;
}

function readSpawnAgentTerminalResult(details: unknown): SpawnAgentTerminalResultLike | null {
	if (!isRecord(details)) return null;
	if (!isSpawnedAgentStatus(details.status)) return null;
	return {
		status: details.status,
		stopReason: typeof details.stopReason === "string" ? details.stopReason : undefined,
		text: typeof details.text === "string" ? details.text : undefined,
	};
}

function readSpawnAgentVerificationReport(details: unknown): SpawnAgentVerificationReportLike | null {
	if (!isRecord(details)) return null;
	if (details.status !== "PASS" && details.status !== "FAIL") return null;
	if (!Array.isArray(details.issues) || details.issues.some((issue) => typeof issue !== "string")) return null;
	return {
		status: details.status,
		issues: details.issues,
	};
}

function readSpawnAgentCompositeDetails(details: unknown): SpawnAgentCompositeDetailsLike | null {
	if (!isRecord(details)) return null;
	const worker = readSpawnAgentDetails(details.worker);
	const verifier = readSpawnAgentDetails(details.verifier);
	const workerResult = readSpawnAgentTerminalResult(details.workerResult);
	const verifierResult = readSpawnAgentTerminalResult(details.verifierResult);
	const verificationReport = readSpawnAgentVerificationReport(details.verificationReport);
	if (!worker && !verifier) return null;
	return {
		worker: worker ?? undefined,
		workerResult: workerResult ?? undefined,
		verifier: verifier ?? undefined,
		verifierResult: verifierResult ?? undefined,
		verificationReport: verificationReport ?? undefined,
	};
}

function getFinalAssistantMessage(sessionPath: string): AssistantMessage | null {
	if (!existsSync(sessionPath)) {
		return null;
	}
	const { messages } = loadThreadMessagesFromSessionFile(sessionPath);
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const assistant = message as AssistantMessage;
		if (assistant.stopReason === "toolUse") continue;
		return assistant;
	}
	return null;
}

function deriveStatus(sessionPath: string): Pick<SpawnedAgentSummary, "status" | "stopReason" | "text"> {
	if (!existsSync(sessionPath)) {
		return { status: "not_found" };
	}
	const finalAssistant = getFinalAssistantMessage(sessionPath);
	if (!finalAssistant) {
		return { status: "running" };
	}
	const text =
		finalAssistant.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("") || undefined;
	if (finalAssistant.stopReason === "error") {
		return { status: "error", stopReason: finalAssistant.stopReason, text };
	}
	if (finalAssistant.stopReason === "aborted") {
		return { status: "aborted", stopReason: finalAssistant.stopReason, text };
	}
	return { status: "completed", stopReason: finalAssistant.stopReason, text };
}

function resolveSessionPath(sessionId: string, preferredPath: string): string {
	if (preferredPath && existsSync(preferredPath)) {
		return preferredPath;
	}
	const manager = new SessionManager(false, undefined, true);
	return manager.findSessionByUuidGlobal(sessionId) ?? preferredPath;
}

function buildSpawnedAgentSummary(
	details: SpawnAgentDetailsLike,
	role: SpawnedAgentRole,
	waitedBySessionId: Map<string, WaitAgentResultLike>,
	terminalResult?: SpawnAgentTerminalResultLike,
	verificationReport?: SpawnAgentVerificationReportLike,
): SpawnedAgentSummary {
	const waited = waitedBySessionId.get(details.sessionId);
	const sessionPath = resolveSessionPath(details.sessionId, details.sessionFile);
	const derived = deriveStatus(sessionPath);
	if (terminalResult) {
		return {
			sessionId: details.sessionId,
			sessionFile: sessionPath,
			effectiveModel: details.effectiveModel,
			effectiveReasoning: details.effectiveReasoning,
			role,
			waited: true,
			status: terminalResult.status,
			stopReason: terminalResult.stopReason,
			text: terminalResult.text,
			verificationStatus: verificationReport?.status,
			verificationIssues: verificationReport?.issues,
		};
	}
	return {
		sessionId: details.sessionId,
		sessionFile: sessionPath,
		effectiveModel: details.effectiveModel,
		effectiveReasoning: details.effectiveReasoning,
		role,
		waited: Boolean(waited),
		status: waited ? (waited.status === "completed" ? "completed" : derived.status) : derived.status,
		stopReason: waited?.stopReason ?? derived.stopReason,
		text: waited?.text ?? derived.text,
		verificationStatus: verificationReport?.status,
		verificationIssues: verificationReport?.issues,
	};
}

export function resolveSpawnedAgentSessionPath(sessionId: string, preferredPath?: string): string | null {
	const candidate = resolveSessionPath(sessionId, preferredPath ?? "");
	return candidate && existsSync(candidate) ? candidate : null;
}

export function inspectSpawnedAgentSession(
	sessionId: string,
	preferredPath?: string,
): Pick<SpawnedAgentSummary, "sessionId" | "sessionFile" | "status" | "stopReason" | "text"> {
	const sessionPath = resolveSpawnedAgentSessionPath(sessionId, preferredPath);
	if (!sessionPath) {
		return { sessionId, sessionFile: preferredPath ?? "", status: "not_found" };
	}
	return {
		sessionId,
		sessionFile: sessionPath,
		...deriveStatus(sessionPath),
	};
}

export function collectSpawnedAgentsFromParentSession(parentSessionFile: string): SpawnedAgentSummary[] {
	let messages: Message[];
	try {
		({ messages } = loadThreadMessagesFromSessionFile(parentSessionFile));
	} catch {
		return [];
	}
	const waitedBySessionId = new Map<string, WaitAgentResultLike>();
	const summaries: SpawnedAgentSummary[] = [];

	for (const message of messages) {
		if (!isToolResultMessage(message)) continue;
		if (message.toolName === "wait_agent") {
			for (const result of readWaitAgentResults(message.details)) {
				waitedBySessionId.set(result.sessionId, result);
			}
		}
	}

	for (const message of messages) {
		if (!isToolResultMessage(message)) continue;
		if (message.toolName !== "spawn_agent") continue;
		const composite = readSpawnAgentCompositeDetails(message.details);
		if (composite) {
			if (composite.worker) {
				summaries.push(
					buildSpawnedAgentSummary(composite.worker, "worker", waitedBySessionId, composite.workerResult),
				);
			}
			if (composite.verifier) {
				summaries.push(
					buildSpawnedAgentSummary(
						composite.verifier,
						"verifier",
						waitedBySessionId,
						composite.verifierResult,
						composite.verificationReport,
					),
				);
			}
			continue;
		}
		const details = readSpawnAgentDetails(message.details);
		if (!details) continue;
		summaries.push(buildSpawnedAgentSummary(details, "child", waitedBySessionId));
	}

	return summaries;
}

export function buildSpawnedAgentsReminder(parentSessionFile: string): string | null {
	const pending = collectSpawnedAgentsFromParentSession(parentSessionFile).filter((summary) => !summary.waited);
	if (pending.length === 0) {
		return null;
	}
	const ids = pending.map((summary) => summary.sessionId).join(", ");
	return `\n\n<system_reminder pending_spawned_agents="${pending.length}">There are spawned child agents with unwaited results or pending work. Use wait_agent for the relevant ids before finalizing if their work matters. Child sessions: ${ids}. If multiple children are relevant, wait_agent on them in parallel.</system_reminder>`;
}

export function formatSpawnedAgentsReport(parentSessionFile: string): string {
	const summaries = collectSpawnedAgentsFromParentSession(parentSessionFile);
	if (summaries.length === 0) {
		return "Spawned Agents\n\nNo spawned child agents in this session.";
	}
	const lines = ["Spawned Agents", ""];
	for (const summary of summaries) {
		const rolePrefix = summary.role === "child" ? "" : `${summary.role} `;
		lines.push(`${rolePrefix}${summary.sessionId} ${summary.status} ${summary.waited ? "waited" : "unwaited"}`);
		lines.push(`${summary.effectiveModel} • ${summary.effectiveReasoning}`);
		if (summary.verificationStatus) {
			lines.push(`verification ${summary.verificationStatus}`);
			for (const issue of summary.verificationIssues ?? []) {
				lines.push(`- ${issue}`);
			}
		} else if (summary.text) {
			lines.push(summary.text);
		}
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

export function createSpawnedAgentsReminderPreprocessor(
	sessionManager: Pick<SessionManager, "getSessionFile">,
	base?: (messages: Message[], abortSignal?: AbortSignal) => Message[] | Promise<Message[]>,
): (messages: Message[], abortSignal?: AbortSignal) => Promise<Message[]> {
	return async (messages: Message[], abortSignal?: AbortSignal) => {
		const processed = base ? await base(messages, abortSignal) : messages;
		const reminder = buildSpawnedAgentsReminder(sessionManager.getSessionFile());
		if (!reminder) {
			return processed;
		}
		return processed.map((message, index) => {
			if (index !== processed.length - 1 || message.role !== "user") {
				return message;
			}
			if (!Array.isArray(message.content)) {
				return message;
			}
			return {
				...message,
				content: message.content.map((block: (typeof message.content)[number]) =>
					block.type === "text" ? { ...block, text: `${block.text}${reminder}` } : block,
				),
			};
		});
	};
}
