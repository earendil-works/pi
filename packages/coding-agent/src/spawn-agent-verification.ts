import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inspectSpawnedAgentSession, type SpawnedAgentStatus } from "./spawned-agents.js";

export const VERIFIER_READ_ONLY_TOOLS = ["read", "bash", "grep", "glob"] as const;

export type SpawnAgentVerificationStatus = "PASS" | "FAIL";

export interface SpawnAgentVerificationRunRequest {
	workerSessionId: string;
	workerSessionFile: string;
	missionPath?: string;
	verificationChecks?: string[];
}

export interface SpawnAgentVerificationReport {
	status: SpawnAgentVerificationStatus;
	issues: string[];
}

export interface SpawnAgentTerminalResult {
	status: SpawnedAgentStatus | "timed_out";
	stopReason?: string;
	text?: string;
}

function escapeXml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function extractTagValue(text: string, tagName: string): string | null {
	const match = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i").exec(text);
	return match ? match[1].trim() : null;
}

function extractIssueValues(text: string): string[] {
	return [...text.matchAll(/<issue>([\s\S]*?)<\/issue>/gi)]
		.map((match) => match[1]?.trim() ?? "")
		.filter((issue) => issue.length > 0);
}

export function buildSpawnAgentVerifierSystemPrompt(): string {
	return `<conversation_rules>
You are an independent verifier for a spawned coding-agent task.

Role:
- verify the completed worker result in a separate session
- check correctness and adherence to the requested specification
- stay read-only with respect to repository source files

Capabilities:
- inspect local files
- search the codebase
- run read-only verification commands

Hard rules:
- do not modify source files
- do not claim success without evidence
- when something cannot be verified, call it out as an issue

Return exactly this XML shape:
<verification_report>
<status>PASS|FAIL</status>
<issues>
<issue>Concrete issue</issue>
</issues>
</verification_report>

Use PASS only when you found no concrete issues.
Use FAIL when any requested check is not satisfied, the worker result is incomplete, or the relevant SPEC.md cannot be verified.
</conversation_rules>`;
}

export function buildSpawnAgentVerifierPrompt(request: SpawnAgentVerificationRunRequest): string {
	const missionPath = request.missionPath ? resolve(request.missionPath) : null;
	const specPath = missionPath ? join(missionPath, "SPEC.md") : null;
	const checks = request.verificationChecks?.filter((check) => check.trim().length > 0) ?? [];
	const checksBlock =
		checks.length > 0
			? checks.map((check, index) => `${index + 1}. ${check}`).join("\n")
			: "1. Check correctness of the worker result.\n2. Check adherence to the relevant specification.";

	return `Verify this completed worker task in read-only mode.

<worker_session>
<session_id>${escapeXml(request.workerSessionId)}</session_id>
<session_file>${escapeXml(request.workerSessionFile)}</session_file>
</worker_session>

${missionPath ? `<mission_path>${escapeXml(missionPath)}</mission_path>` : ""}
${specPath ? `<spec_path>${escapeXml(specPath)}</spec_path>` : ""}

<requested_checks>
${escapeXml(checksBlock)}
</requested_checks>

Instructions:
- inspect the worker session file and its final result
- if a mission path is provided, read SPEC.md from that mission path
- report only concrete issues
- return PASS only when the worker result and spec adherence checks both look good

Return exactly the XML shape from your system prompt.`;
}

export function formatSpawnAgentVerificationReport(report: SpawnAgentVerificationReport): string {
	const issuesBlock =
		report.issues.length > 0 ? report.issues.map((issue) => `<issue>${escapeXml(issue)}</issue>`).join("\n") : "";
	return `<verification_report>\n<status>${report.status}</status>\n<issues>${issuesBlock ? `\n${issuesBlock}\n` : ""}</issues>\n</verification_report>`;
}

export function parseSpawnAgentVerificationReport(text: string): SpawnAgentVerificationReport {
	const explicitStatus = extractTagValue(text, "status");
	const issuesBlock = extractTagValue(text, "issues") ?? "";
	const parsedIssues = extractIssueValues(issuesBlock);

	if (explicitStatus === "PASS" || explicitStatus === "FAIL") {
		return {
			status: explicitStatus,
			issues: parsedIssues,
		};
	}

	const fallbackStatus = /\bFAIL\b/i.test(text) ? "FAIL" : /\bPASS\b/i.test(text) ? "PASS" : null;
	if (fallbackStatus) {
		return {
			status: fallbackStatus,
			issues: parsedIssues,
		};
	}

	return {
		status: "FAIL",
		issues: ["Verifier did not return the required PASS/FAIL report shape."],
	};
}

export function runDeterministicSpawnAgentVerification(
	request: SpawnAgentVerificationRunRequest,
): SpawnAgentVerificationReport {
	const issues: string[] = [];
	const worker = inspectSpawnedAgentSession(request.workerSessionId, request.workerSessionFile);

	if (worker.status === "not_found") {
		issues.push(`Worker session ${request.workerSessionId} was not found.`);
	} else if (worker.status !== "completed") {
		issues.push(
			`Worker session ${request.workerSessionId} did not complete successfully (status: ${worker.status}).`,
		);
	}

	if (!worker.text?.trim()) {
		issues.push("Worker result was empty or unavailable.");
	}

	if (request.missionPath) {
		const resolvedMissionPath = resolve(request.missionPath);
		const specPath = join(resolvedMissionPath, "SPEC.md");
		if (!existsSync(specPath)) {
			issues.push(`SPEC.md was not found at ${specPath}.`);
		} else {
			const specText = readFileSync(specPath, "utf8").trim();
			if (specText.length === 0) {
				issues.push(`SPEC.md at ${specPath} was empty.`);
			}
		}
	}

	for (const check of request.verificationChecks ?? []) {
		const trimmedCheck = check.trim();
		if (trimmedCheck.length === 0) {
			continue;
		}
		if (/SPEC\.md/i.test(trimmedCheck) && !request.missionPath) {
			issues.push(`Requested check "${trimmedCheck}" requires missionPath/SPEC.md context, but none was provided.`);
		}
	}

	return {
		status: issues.length === 0 ? "PASS" : "FAIL",
		issues,
	};
}
