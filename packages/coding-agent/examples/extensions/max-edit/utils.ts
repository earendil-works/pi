import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { TextContent } from "@mariozechner/pi-ai";

export interface ProposedEditOperation {
	kind: "edit";
	path: string;
	oldText: string;
	newText: string;
	summary?: string;
}

export interface ProposedWriteOperation {
	kind: "write";
	path: string;
	content: string;
	summary?: string;
}

export type ProposedOperation = ProposedEditOperation | ProposedWriteOperation;

export interface CandidateRun {
	index: number;
	summary: string;
	exitCode: number;
	stderr: string;
	proposals: ProposedOperation[];
}

export interface SelectorChoice {
	candidateIndex: number;
	reason: string;
}

interface JsonModeEvent {
	type?: string;
	message?: JsonModeMessage;
}

interface JsonModeMessage {
	role?: string;
	toolName?: string;
	content?: Array<{ type: string; text?: string }>;
	details?: unknown;
}

export function extractTextFromBlocks(content: JsonModeMessage["content"]): string {
	if (!Array.isArray(content)) {
		return "";
	}

	return content
		.filter((block): block is TextContent => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

export function parseProposalOutput(stdout: string): { summary: string; proposals: ProposedOperation[] } {
	const proposals: ProposedOperation[] = [];
	let summary = "";

	for (const rawLine of stdout.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;

		let event: JsonModeEvent;
		try {
			event = JSON.parse(line) as JsonModeEvent;
		} catch {
			continue;
		}

		if (event.type === "message_end" && event.message?.role === "assistant") {
			const text = extractTextFromBlocks(event.message.content);
			if (text) {
				summary = text;
			}
		}

		if (event.type !== "tool_result_end") {
			continue;
		}

		const toolName = event.message?.toolName;
		if (toolName !== "propose_edit" && toolName !== "propose_write") {
			continue;
		}

		const details = event.message?.details;
		if (!details || typeof details !== "object") {
			continue;
		}

		const proposal = details as ProposedOperation;
		if (proposal.kind === "edit" || proposal.kind === "write") {
			proposals.push(proposal);
		}
	}

	return { summary, proposals };
}

export function buildSelectorPrompt(task: string, candidates: CandidateRun[]): string {
	const sections = [
		"You are choosing the best candidate edit plan.",
		'Return JSON only in this exact shape: {"index": <1-based candidate index>, "reason": "..."}',
		"Pick the candidate that best satisfies the task with the smallest safe blast radius and the most coherent operations.",
		"",
		`Task:\n${task}`,
		"",
		"Candidates:",
	];

	for (const candidate of candidates) {
		const proposalLines =
			candidate.proposals.length > 0
				? candidate.proposals.map((proposal) => formatProposalLine(proposal)).join("\n")
				: "(no proposals)";
		sections.push(
			[
				`Candidate ${candidate.index + 1}`,
				`Summary: ${candidate.summary || "(no summary)"}`,
				`Exit code: ${candidate.exitCode}`,
				`Operations:\n${proposalLines}`,
			].join("\n"),
		);
		sections.push("");
	}

	return sections.join("\n");
}

function formatProposalLine(proposal: ProposedOperation): string {
	if (proposal.kind === "edit") {
		return `- edit ${proposal.path}${proposal.summary ? `: ${proposal.summary}` : ""}`;
	}
	return `- write ${proposal.path}${proposal.summary ? `: ${proposal.summary}` : ""}`;
}

export function parseSelectorChoice(raw: string, candidateCount: number): SelectorChoice {
	const match = raw.match(/\{[\s\S]*\}/);
	if (!match) {
		throw new Error("Selector did not return JSON");
	}

	const parsed = JSON.parse(match[0]) as { index?: number; reason?: string };
	if (!Number.isInteger(parsed.index) || parsed.index === undefined) {
		throw new Error("Selector JSON is missing a valid index");
	}

	if (parsed.index < 1 || parsed.index > candidateCount) {
		throw new Error(`Selector index ${parsed.index} is out of range`);
	}

	return {
		candidateIndex: parsed.index - 1,
		reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "No reason provided.",
	};
}

export function validateAndPrepareOperations(
	cwd: string,
	proposals: ProposedOperation[],
): Array<{ path: string; content: string }> {
	const staged = new Map<string, string>();
	const prepared: Array<{ path: string; content: string }> = [];

	for (const proposal of proposals) {
		const absolutePath = resolve(cwd, proposal.path);
		const current =
			staged.get(absolutePath) ?? (existsSync(absolutePath) ? readFileSync(absolutePath, "utf-8") : undefined);

		if (proposal.kind === "write") {
			staged.set(absolutePath, proposal.content);
			continue;
		}

		if (current === undefined) {
			throw new Error(`Cannot edit missing file: ${proposal.path}`);
		}

		const occurrences = current.split(proposal.oldText).length - 1;
		if (occurrences === 0) {
			throw new Error(`Could not find exact text for edit in ${proposal.path}`);
		}
		if (occurrences > 1) {
			throw new Error(`Edit text is not unique in ${proposal.path}`);
		}

		staged.set(absolutePath, current.replace(proposal.oldText, proposal.newText));
	}

	for (const [absolutePath, content] of staged.entries()) {
		prepared.push({ path: absolutePath, content });
	}

	return prepared;
}

export function applyPreparedOperations(prepared: Array<{ path: string; content: string }>): void {
	for (const entry of prepared) {
		mkdirSync(dirname(entry.path), { recursive: true });
		writeFileSync(entry.path, entry.content, "utf-8");
	}
}
