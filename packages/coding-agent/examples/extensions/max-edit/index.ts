import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	applyPreparedOperations,
	buildSelectorPrompt,
	type CandidateRun,
	parseProposalOutput,
	parseSelectorChoice,
	validateAndPrepareOperations,
} from "./utils.js";

const MaxEditParams = Type.Object({
	task: Type.String({ description: "Editing task to solve" }),
	candidates: Type.Optional(Type.Number({ description: "Number of candidates to generate (default: 3)" })),
	cwd: Type.Optional(Type.String({ description: "Working directory override" })),
});

const DEFAULT_CANDIDATES = 3;
const PROPOSAL_EXTENSION_PATH = fileURLToPath(new URL("./proposal-tools.ts", import.meta.url));
const MAX_EDIT_CUSTOM_TYPE = "max_edit_summary";

interface MaxEditDetails {
	task: string;
	selectedCandidateIndex: number;
	selectionReason: string;
	appliedFiles: string[];
	candidates: CandidateRun[];
}

const CANDIDATE_STRATEGIES = [
	"Prefer the smallest clean patch that solves the task directly.",
	"Prefer the clearest and most maintainable edit even if it is slightly larger.",
	"Prefer the variant that handles edge cases explicitly without expanding scope.",
];

function getModelArgs(ctx: ExtensionContext): string[] {
	if (!ctx.model) {
		return [];
	}
	return ["--model", `${ctx.model.provider}/${ctx.model.id}`];
}

function buildCandidatePrompt(task: string, index: number, total: number): string {
	const strategy = CANDIDATE_STRATEGIES[index % CANDIDATE_STRATEGIES.length];
	return [
		`You are candidate ${index + 1} of ${total} for a max-edit comparison.`,
		strategy,
		"Inspect the repo with read, grep, find, ls, tree, and read_subtree as needed.",
		"Do not mutate files directly.",
		"Record every intended change with propose_edit or propose_write.",
		"After proposing the full solution, reply with a short summary of the approach and stop.",
		"",
		`Task:\n${task}`,
	].join("\n");
}

async function runCandidate(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	task: string,
	index: number,
	total: number,
	cwd: string,
	signal?: AbortSignal,
): Promise<CandidateRun> {
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--extension",
		PROPOSAL_EXTENSION_PATH,
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--tools",
		"read,grep,find,ls,tree,read_subtree,propose_edit,propose_write",
		...getModelArgs(ctx),
		buildCandidatePrompt(task, index, total),
	];

	const result = await pi.exec("pi", args, {
		cwd,
		signal,
		timeout: 120000,
	});
	const parsed = parseProposalOutput(result.stdout);

	return {
		index,
		summary: parsed.summary,
		exitCode: result.code,
		stderr: result.stderr.trim(),
		proposals: parsed.proposals,
	};
}

async function autoSelectCandidate(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	task: string,
	candidates: CandidateRun[],
	cwd: string,
	signal?: AbortSignal,
): Promise<{ candidate: CandidateRun; reason: string }> {
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-tools",
		...getModelArgs(ctx),
		buildSelectorPrompt(task, candidates),
	];

	const result = await pi.exec("pi", args, {
		cwd,
		signal,
		timeout: 120000,
	});
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || "Selector run failed");
	}

	const parsed = parseProposalOutput(result.stdout);
	const choice = parseSelectorChoice(parsed.summary, candidates.length);
	return {
		candidate: candidates[choice.candidateIndex],
		reason: choice.reason,
	};
}

async function runMaxEdit(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	task: string,
	options?: { candidates?: number; cwd?: string; signal?: AbortSignal },
): Promise<MaxEditDetails> {
	const candidateCount = Math.max(1, options?.candidates ?? DEFAULT_CANDIDATES);
	const workingDirectory = options?.cwd ? resolve(ctx.cwd, options.cwd) : ctx.cwd;

	const candidates = await Promise.all(
		Array.from({ length: candidateCount }, (_, index) =>
			runCandidate(pi, ctx, task, index, candidateCount, workingDirectory, options?.signal),
		),
	);

	const validCandidates = candidates.filter((candidate) => candidate.exitCode === 0 && candidate.proposals.length > 0);
	if (validCandidates.length === 0) {
		throw new Error("No candidate produced an applyable proposal set.");
	}

	const { candidate, reason } = await autoSelectCandidate(
		pi,
		ctx,
		task,
		validCandidates,
		workingDirectory,
		options?.signal,
	);
	const prepared = validateAndPrepareOperations(workingDirectory, candidate.proposals);
	applyPreparedOperations(prepared);

	return {
		task,
		selectedCandidateIndex: candidate.index,
		selectionReason: reason,
		appliedFiles: prepared.map((entry) => entry.path),
		candidates,
	};
}

function formatSummary(details: MaxEditDetails): string {
	const applied = details.appliedFiles.length > 0 ? details.appliedFiles.join(", ") : "(none)";
	return [
		`max-edit selected candidate ${details.selectedCandidateIndex + 1}.`,
		`Reason: ${details.selectionReason}`,
		`Applied files: ${applied}`,
	].join("\n");
}

async function runFromCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const task = args.trim();
	if (!task) {
		ctx.ui.notify("Usage: /max-edit <task>", "warning");
		return;
	}

	const details = await runMaxEdit(pi, ctx, task);
	pi.sendMessage({
		customType: MAX_EDIT_CUSTOM_TYPE,
		content: formatSummary(details),
		display: true,
		details,
	});
}

export default function maxEditExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "max_edit",
		label: "Max Edit",
		description: "Generate multiple proposal-only edit candidates, auto-select the best one, and apply it.",
		promptSnippet: "Generate multiple edit candidates, auto-select the best proposal, and apply it.",
		parameters: MaxEditParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const details = await runMaxEdit(pi, ctx, params.task, {
				candidates: params.candidates,
				cwd: params.cwd,
				signal,
			});

			return {
				content: [{ type: "text", text: formatSummary(details) }],
				details,
			};
		},
	});

	pi.registerCommand("max-edit", {
		description: "Run best-of-N edit mode and apply the selected proposal: /max-edit <task>",
		handler: async (args, ctx) => {
			try {
				await runFromCommand(pi, args, ctx);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`max-edit failed: ${message}`, "error");
			}
		},
	});
}
