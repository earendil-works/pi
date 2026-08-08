import type { AssistantMessage, Message, Model, TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Agent } from "../../agent.ts";
import type { AgentMessage, AgentTool, AgentToolResult, StreamFn, ThinkingLevel } from "../../types.ts";
import { extractJson } from "./task.ts";

/**
 * Parameters for the `review` tool.
 */
export const reviewParametersSchema = Type.Object({
	diff: Type.String({
		description:
			"The change under review as unified diff text (e.g. output of `git diff`), or a description of uncommitted changes.",
	}),
	focus: Type.Optional(
		Type.String({ description: "Optional area to focus the review on (e.g. auth, error handling, perf)." }),
	),
	context: Type.Optional(
		Type.String({ description: "Optional context about the change (why it exists, related PR/issue)." }),
	),
	reviewers: Type.Optional(
		Type.Integer({
			minimum: 2,
			maximum: 5,
			default: 3,
			description: "Number of parallel reviewer subagents (default 3, each with a distinct lens).",
		}),
	),
});

export type ReviewParameters = Static<typeof reviewParametersSchema>;

/** Severity levels, P0 most severe. */
export type ReviewSeverity = "P0" | "P1" | "P2" | "P3";

export type ReviewVerdict = "approve" | "changes-requested" | "reject";

/** A single finding from one reviewer. */
export interface ReviewIssue {
	severity: ReviewSeverity;
	confidence: number;
	location?: string;
	summary: string;
	recommendation?: string;
}

/** Structured details returned alongside the review summary. */
export interface ReviewToolDetails {
	/** Aggregate verdict across reviewers. */
	verdict: ReviewVerdict;
	/** Total number of findings (all severities). */
	issueCount: number;
	/** Findings per severity level. */
	bySeverity: Partial<Record<ReviewSeverity, number>>;
	/** Number of reviewer subagents that completed. */
	reviewerCount: number;
	/** Wall-clock duration of the review run in milliseconds. */
	durationMs: number;
}

/** Options for constructing the `review` tool. */
export interface ReviewToolOptions {
	model: Model<any>;
	streamFn: StreamFn;
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	/** System prompt for reviewer subagents. */
	systemPrompt?: string;
	/** Lazily resolved system prompt, evaluated per subagent spawn. Takes precedence over `systemPrompt` when both are set. */
	getSystemPrompt?: () => string;
	/** Thinking level for reviewer subagents. Defaults to "off". */
	thinkingLevel?: ThinkingLevel;
}

/** Distinct reviewer lenses; the first `reviewers` lenses are used. */
const REVIEWER_LENSES = [
	{
		id: "correctness",
		instruction:
			"Focus on CORRECTNESS: logic errors, edge cases, concurrency bugs, off-by-one, null/undefined handling, and places where the change breaks existing behavior.",
	},
	{
		id: "security",
		instruction:
			"Focus on SECURITY: injection, authz/authn bypass, secrets exposure, path traversal, unsafe deserialization, and other vulnerabilities introduced or exposed by this change.",
	},
	{
		id: "maintainability",
		instruction:
			"Focus on MAINTAINABILITY: readability, naming, dead code, duplication, test coverage, and whether the change fits the surrounding architecture.",
	},
	{
		id: "performance",
		instruction:
			"Focus on PERFORMANCE: accidental quadratic behavior, N+1 queries, blocking hot paths, memory/CPU regressions, and avoidable allocations.",
	},
	{
		id: "regression",
		instruction:
			"Focus on REGRESSIONS: behavioral changes that could break callers, API compatibility, migration concerns, and silent failures.",
	},
] as const;

function reviewPrompt(
	diff: string,
	lens: (typeof REVIEWER_LENSES)[number],
	focus: string | undefined,
	context: string | undefined,
): string {
	return [
		"Review the following code change as a senior engineer.",
		lens.instruction,
		focus ? `Additionally keep this focus area in mind: ${focus}` : "",
		context ? `Change context: ${context}` : "",
		"",
		"```diff",
		diff,
		"```",
		"",
		"Respond with ONLY a JSON object of this exact shape:",
		`{"verdict":"approve|changes-requested|reject","issues":[{"severity":"P0|P1|P2|P3","confidence":0.0,"location":"file:line or symbol","summary":"short description","recommendation":"suggested fix (optional)"}],"summary":"one-paragraph review summary"}`,
		"Severity: P0 = must fix before merge, P1 = should fix, P2 = nice to fix, P3 = nit. Confidence 0-1.",
		"Return only the JSON, no prose around it.",
	]
		.filter((line) => line !== "")
		.join("\n");
}

/** Aggregate a reviewer's parsed output into a structured issue list. */
function parseReviewOutput(text: string): { verdict?: ReviewVerdict; issues: ReviewIssue[]; summary: string } {
	const raw = extractJson(text) as { verdict?: unknown; issues?: unknown; summary?: unknown } | undefined;
	if (!raw || typeof raw !== "object") {
		return { issues: [], summary: text.slice(0, 500) };
	}
	const issues = Array.isArray(raw.issues)
		? (
				raw.issues as {
					severity?: unknown;
					confidence?: unknown;
					location?: unknown;
					summary?: unknown;
					recommendation?: unknown;
				}[]
			)
				.filter((issue) => issue && typeof issue === "object" && typeof issue.summary === "string")
				.map((issue) => ({
					severity: (["P0", "P1", "P2", "P3"] as const).includes(issue.severity as ReviewSeverity)
						? (issue.severity as ReviewSeverity)
						: ("P3" as const),
					confidence:
						typeof issue.confidence === "number" && issue.confidence >= 0 && issue.confidence <= 1
							? issue.confidence
							: 0.5,
					location: typeof issue.location === "string" ? issue.location : undefined,
					summary: typeof issue.summary === "string" ? issue.summary : "",
					recommendation: typeof issue.recommendation === "string" ? issue.recommendation : undefined,
				}))
		: [];
	const verdict =
		raw.verdict === "approve" || raw.verdict === "changes-requested" || raw.verdict === "reject"
			? (raw.verdict as ReviewVerdict)
			: undefined;
	return {
		verdict,
		issues,
		summary: typeof raw.summary === "string" ? raw.summary : "",
	};
}

const SEVERITY_RANK: Record<ReviewSeverity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** Aggregate the aggregate verdict from all findings. */
export function aggregateVerdict(allIssues: ReviewIssue[]): ReviewVerdict {
	if (allIssues.some((issue) => issue.severity === "P0")) {
		return "reject";
	}
	if (allIssues.some((issue) => issue.severity === "P1")) {
		return "changes-requested";
	}
	return "approve";
}

/**
 * The `review` tool: runs parallel reviewer subagents over a diff and returns
 * a P0–P3 ranked issue list with an aggregate verdict. Reviewers run
 * concurrently, each with a distinct lens (correctness/security/maintainability/
 * performance/regression).
 */
export function createReviewTool(options: ReviewToolOptions): AgentTool<typeof reviewParametersSchema> {
	const systemPrompt =
		options.getSystemPrompt?.() ??
		options.systemPrompt ??
		"You are a rigorous code reviewer. Follow the requested output format exactly.";

	return {
		name: "review",
		label: "review",
		description:
			"Review a code change (unified diff) with N parallel reviewer subagents, each with a distinct lens. Returns P0–P3 ranked issues and an aggregate verdict (approve / changes-requested / reject).",
		parameters: reviewParametersSchema,
		async execute(_toolCallId, params, signal, _onUpdate): Promise<AgentToolResult<ReviewToolDetails>> {
			const reviewerCount = params.reviewers ?? 3;
			const lenses = REVIEWER_LENSES.slice(0, reviewerCount);
			const started = Date.now();

			// Spawn reviewer subagents in parallel.
			const runs = await Promise.all(
				lenses.map((lens) => {
					const subagent = new Agent({
						streamFn: options.streamFn,
						convertToLlm: options.convertToLlm,
						getApiKey: options.getApiKey,
						initialState: {
							model: options.model,
							systemPrompt,
							tools: [],
							thinkingLevel: options.thinkingLevel ?? "off",
							messages: [],
						},
					});
					if (signal) {
						if (signal.aborted) {
							throw new Error("Review was aborted before it started.");
						}
						signal.addEventListener("abort", () => subagent.abort(), { once: true });
					}
					const prompt = reviewPrompt(params.diff, lens, params.focus, params.context);
					return subagent.prompt(prompt).then(() => {
						const text = subagent.state.messages
							.filter((m): m is AssistantMessage => m.role === "assistant")
							.flatMap((m) => m.content)
							.filter((c): c is TextContent => c.type === "text")
							.map((c) => c.text)
							.join("\n");
						return parseReviewOutput(text);
					});
				}),
			);

			// Merge and rank all findings.
			const allIssues = runs
				.flatMap((run) => run.issues)
				.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.confidence - a.confidence);
			const verdict = aggregateVerdict(allIssues);
			const bySeverity: Partial<Record<ReviewSeverity, number>> = {};
			for (const issue of allIssues) {
				bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1;
			}

			const completedReviewers = runs.filter((run) => run.issues.length > 0 || run.verdict).length;
			const details: ReviewToolDetails = {
				verdict,
				issueCount: allIssues.length,
				bySeverity,
				reviewerCount: completedReviewers,
				durationMs: Date.now() - started,
			};

			const summary = {
				verdict,
				issues: allIssues,
				reviewers: runs.map((run, index) => ({
					lens: lenses[index]?.id,
					verdict: run.verdict,
					summary: run.summary,
				})),
			};

			return {
				content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
				details,
			};
		},
	};
}
