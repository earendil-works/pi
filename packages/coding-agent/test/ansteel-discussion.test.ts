import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ANSTEEL_ROLES,
	type AnsteelConfig,
	type AnsteelDiscussionStage,
	AnsteelGovernanceSetupError,
	type AnsteelRole,
	createAnsteelEvidencePackage,
	createAnsteelRawTurnSession,
	createAnsteelSetupFailureMarkdown,
	createAnsteelToolBudget,
	getAnsteelReviewExitCode,
	loadAnsteelConfig,
	runAnsteelDiscussion,
	runAnsteelProjectReview,
	writeAnsteelReport,
} from "../src/core/ansteel-discussion.ts";
import { getAnsteelModelBoundary } from "../src/main.ts";

type RawTurnMessage = {
	role: string;
	content?: Array<{ type: string; text?: string }>;
	stopReason?: string;
	errorMessage?: string;
};

type RawTurnSessionSource = {
	readonly messages: readonly RawTurnMessage[];
	prompt: (text: string) => Promise<void>;
	subscribeToAssistantMessageEnd: (listener: (message: unknown) => void) => () => void;
	subscribeToAgentEvent?: (listener: (event: unknown) => void) => () => void;
	abort?: () => void | Promise<void>;
	dispose: () => void | Promise<void>;
};

function createAssistantMessageEmitter(): {
	emit: (message: RawTurnMessage) => void;
	subscribe: (listener: (message: unknown) => void) => () => void;
} {
	const listeners = new Set<(message: unknown) => void>();
	return {
		emit: (message) => {
			for (const listener of listeners) listener(message);
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

function createAgentEventEmitter(): {
	emit: (event: unknown) => void;
	subscribe: (listener: (event: unknown) => void) => () => void;
} {
	const listeners = new Set<(event: unknown) => void>();
	return {
		emit: (event) => {
			for (const listener of listeners) listener(event);
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

function getLegacyCopyText(messages: readonly RawTurnMessage[]): string | undefined {
	const lastAssistant = messages
		.slice()
		.reverse()
		.find((message) => {
			if (message.role !== "assistant") return false;
			return !(message.stopReason === "aborted" && !message.content?.length);
		});
	if (!lastAssistant) return undefined;

	const text = (lastAssistant.content ?? [])
		.filter((content) => content.type === "text")
		.map((content) => content.text ?? "")
		.join("");
	return text.trim() || undefined;
}

const MUTUAL_REVIEW_STAGE_ORDER: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage }> = [
	{ role: "tech-lead", stage: "architecture" },
	{ role: "staff-engineer", stage: "staff-critique" },
	{ role: "qa-engineer", stage: "qa-critique" },
	{ role: "tech-lead", stage: "tech-lead-cross-examination" },
	{ role: "staff-engineer", stage: "staff-cross-examination" },
	{ role: "qa-engineer", stage: "qa-cross-examination" },
	{ role: "tech-lead", stage: "architecture-revision" },
	{ role: "staff-engineer", stage: "staff-revision" },
	{ role: "qa-engineer", stage: "qa-revision" },
	{ role: "tech-lead", stage: "tech-lead-verification" },
	{ role: "staff-engineer", stage: "staff-verification" },
	{ role: "qa-engineer", stage: "qa-verification" },
	{ role: "tech-lead", stage: "consensus" },
	{ role: "staff-engineer", stage: "staff-sign-off" },
	{ role: "qa-engineer", stage: "qa-sign-off" },
];

const COMPLETE_WORK_CARD = [
	"## Conclusion\n[L2] The proposed work card is ready for peer review.",
	"## Evidence\n[L2] Current project evidence was reviewed.",
	"## Assumptions and Unknowns\n[L3] Remaining uncertainty has a verification path.",
	"## Alternatives and Trade-offs\n[L2] The selected approach has stated trade-offs.",
	"## Self-Refutation Conditions\n[L3] Contradictory evidence would invalidate this work card.",
	"## Questions for Peers\n[L2] Review the stated evidence and trade-offs.",
].join("\n\n");

function completeWorkCard(response: string): string {
	return `${response}\n\n${COMPLETE_WORK_CARD}`;
}

const MUTUAL_REVIEW_RESPONSES: Record<AnsteelDiscussionStage, string> = {
	architecture: `[L2] Tech Lead work card\n\n${COMPLETE_WORK_CARD}`,
	"staff-critique": `[L2] Staff Engineer work card\n\n${COMPLETE_WORK_CARD}`,
	"qa-critique": `[L2] QA Engineer work card\n\n${COMPLETE_WORK_CARD}`,
	"tech-lead-cross-examination":
		"ISSUE: TL-CROSS | TARGET: staff-engineer\nNO ISSUES | TARGET: qa-engineer\n[L2] Challenge the implementation trade-off.",
	"staff-cross-examination":
		"ISSUE: STAFF-CROSS | TARGET: qa-engineer\nNO ISSUES | TARGET: tech-lead\n[L2] Challenge the test strategy.",
	"qa-cross-examination":
		"ISSUE: QA-CROSS | TARGET: tech-lead\nNO ISSUES | TARGET: staff-engineer\n[L2] Challenge the evidence boundary.",
	"architecture-revision": `RESOLUTION: QA-CROSS | RESOLVED\n[L2] Tech Lead revised work card\n\n${COMPLETE_WORK_CARD}`,
	"staff-revision": `RESOLUTION: TL-CROSS | RESOLVED\n[L2] Staff revised work card\n\n${COMPLETE_WORK_CARD}`,
	"qa-revision": `RESOLUTION: STAFF-CROSS | RESOLVED\n[L2] QA revised work card\n\n${COMPLETE_WORK_CARD}`,
	"tech-lead-verification": "VERDICT: APPROVE",
	"staff-verification": "VERDICT: APPROVE",
	"qa-verification": "VERDICT: APPROVE",
	consensus: "[L1] Immutable consensus",
	"staff-sign-off": "VERDICT: APPROVE",
	"qa-sign-off": "VERDICT: APPROVE",
};

function getStageFromPrompt(prompt: string): AnsteelDiscussionStage {
	const match = /Current stage: ([a-z-]+)\./.exec(prompt);
	if (!match || !(match[1] in MUTUAL_REVIEW_RESPONSES)) {
		throw new Error(`Could not determine Ansteel stage from prompt: ${prompt}`);
	}
	return match[1] as AnsteelDiscussionStage;
}

function responseForMutualReviewStage(
	stage: AnsteelDiscussionStage,
	overrides: Partial<Record<AnsteelDiscussionStage, string>> = {},
): string {
	return overrides[stage] ?? MUTUAL_REVIEW_RESPONSES[stage];
}

const temporaryDirectories: string[] = [];

afterEach(() => {
	while (temporaryDirectories.length > 0) {
		const directory = temporaryDirectories.pop();
		if (directory) rmSync(directory, { recursive: true, force: true });
	}
});

describe("runAnsteelDiscussion", () => {
	it("reports the single-model boundary without claiming model diversity", () => {
		expect(getAnsteelModelBoundary(true)).toContain("may share the same configured model");
		expect(getAnsteelModelBoundary(true)).not.toContain("three distinct configured role models");
		expect(getAnsteelModelBoundary(false)).toBe(
			"Mandatory governance resolved three distinct configured role models. Model diversity supplements, but does not replace, evidence verification.",
		);
	});

	it("emits a visible start and completion event for every completed stage", async () => {
		const progress: string[] = [];

		const result = await runAnsteelDiscussion({
			topic: "Review visible discussion progress",
			onStageEvent: ({ type, role, stage }) => {
				progress.push(`${type}:${role}/${stage}`);
			},
			runRole: async ({ stage }) => responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("approved");
		expect(progress).toEqual(
			MUTUAL_REVIEW_STAGE_ORDER.flatMap(({ role, stage }) => [
				`started:${role}/${stage}`,
				`completed:${role}/${stage}`,
			]),
		);
	});

	it("asks each role for a concise response so later roles can consume the full transcript", async () => {
		let firstPrompt = "";

		await runAnsteelDiscussion({
			topic: "Review concise discussion prompts",
			runRole: async ({ prompt }) => {
				firstPrompt = prompt;
				return "";
			},
		});

		expect(firstPrompt).toContain(
			"Response limit: keep the response within 800 tokens unless code or evidence requires more.",
		);
	});

	it("gives every initial work-card stage an exact heading and marker discipline", async () => {
		const prompts = new Map<AnsteelDiscussionStage, string>();

		const result = await runAnsteelDiscussion({
			topic: "Review work-card prompt compliance",
			runRole: async ({ stage, prompt }) => {
				prompts.set(stage, prompt);
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("approved");
		for (const stage of ["architecture", "staff-critique", "qa-critique"] as const) {
			const prompt = prompts.get(stage) ?? "";
			expect(prompt).toContain("Begin the response with exactly `## Conclusion`.");
			expect(prompt).toContain(
				"Include each exact heading once with nonempty content: `## Conclusion`, `## Evidence`, `## Assumptions and Unknowns`, `## Alternatives and Trade-offs`, `## Self-Refutation Conditions`, and `## Questions for Peers`.",
			);
			expect(prompt).toContain(
				"Do not emit `VERDICT`, `ISSUE`, `NO ISSUES`, or `RESOLUTION` markers in this initial work-card stage.",
			);
		}
	});

	it("gives every revision stage an exact resolution-before-work-card contract", async () => {
		const prompts = new Map<AnsteelDiscussionStage, string>();
		const assignedTechLeadIds = ["STAFF-1", "STAFF-2", "STAFF-3", "QA-1", "QA-2", "QA-3", "QA-4"];

		const result = await runAnsteelDiscussion({
			topic: "Review a complete Tech Lead resolution ledger",
			runRole: async ({ stage, prompt }) => {
				prompts.set(stage, prompt);
				switch (stage) {
					case "staff-cross-examination":
						return [
							"ISSUE: STAFF-1 | TARGET: tech-lead",
							"ISSUE: STAFF-2 | TARGET: tech-lead",
							"ISSUE: STAFF-3 | TARGET: tech-lead",
							"NO ISSUES | TARGET: qa-engineer",
						].join("\n");
					case "qa-cross-examination":
						return [
							"ISSUE: QA-1 | TARGET: tech-lead",
							"ISSUE: QA-2 | TARGET: tech-lead",
							"ISSUE: QA-3 | TARGET: tech-lead",
							"ISSUE: QA-4 | TARGET: tech-lead",
							"NO ISSUES | TARGET: staff-engineer",
						].join("\n");
					case "architecture-revision":
						return completeWorkCard(assignedTechLeadIds.map((id) => `RESOLUTION: ${id} | RESOLVED`).join("\n"));
					case "qa-revision":
						return completeWorkCard("[L2] No open challenge is assigned.");
					default:
						return responseForMutualReviewStage(stage);
				}
			},
		});

		expect(result.terminationReason).toBeUndefined();
		expect(result.verdict).toBe("approved");
		for (const stage of ["architecture-revision", "staff-revision", "qa-revision"] as const) {
			const prompt = prompts.get(stage) ?? "";
			expect(prompt).toContain(
				"Before the revised work card, for every open challenge ID assigned to you, emit exactly one whole-line `RESOLUTION: <assigned-ID> | RESOLVED` marker.",
			);
			expect(prompt).toContain("Emit no `RESOLUTION` marker when no open challenge ID is assigned to you.");
			expect(prompt).toContain(
				"After those resolution markers, publish the revised work card with each exact heading once and nonempty content: `## Conclusion`, `## Evidence`, `## Assumptions and Unknowns`, `## Alternatives and Trade-offs`, `## Self-Refutation Conditions`, and `## Questions for Peers`.",
			);
			expect(prompt).toContain(
				"Do not emit `VERDICT`, `ISSUE`, or `NO ISSUES` markers in this revision stage; reserve them for a subsequent verification stage if required.",
			);
		}
		for (const id of assignedTechLeadIds) {
			expect(prompts.get("architecture-revision")).toContain(`- ${id} from`);
		}
	});

	it("rejects an initial work card that omits required visible sections", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review incomplete initial work card",
			runRole: async ({ stage }) =>
				stage === "architecture"
					? "## Conclusion\n[L2] The architecture is ready for review."
					: responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("incomplete-work-card");
		expect(result.transcript.at(-1)?.stage).toBe("architecture");
		expect(result.markdown).toContain("missing required visible sections: Evidence");
	});

	it("rejects a work card with an empty required section body", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review empty work-card evidence",
			runRole: async ({ stage }) =>
				stage === "architecture"
					? [
							"## Conclusion",
							"[L2] The architecture is ready for review.",
							"## Evidence",
							"## Assumptions and Unknowns",
							"[L3] The integration dependency remains to be checked.",
							"## Alternatives and Trade-offs",
							"[L2] The direct path has the lowest operational cost.",
							"## Self-Refutation Conditions",
							"[L3] A failing integration test invalidates this proposal.",
							"## Questions for Peers",
							"[L2] Verify the proposed evidence boundary.",
						].join("\n\n")
					: responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("incomplete-work-card");
		expect(result.markdown).toContain("missing required visible sections: Evidence");
	});

	it("rejects a work card whose required section contains only a non-required heading", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review heading-only work-card evidence",
			runRole: async ({ stage }) =>
				stage === "architecture"
					? [
							"## Conclusion",
							"[L2] The architecture is ready for review.",
							"## Evidence",
							"## Placeholder",
							"## Assumptions and Unknowns",
							"[L3] The integration dependency remains to be checked.",
							"## Alternatives and Trade-offs",
							"[L2] The direct path has the lowest operational cost.",
							"## Self-Refutation Conditions",
							"[L3] A failing integration test invalidates this proposal.",
							"## Questions for Peers",
							"[L2] Verify the proposed evidence boundary.",
						].join("\n\n")
					: responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("incomplete-work-card");
		expect(result.markdown).toContain("missing required visible sections: Evidence");
	});

	it("accepts required headings wrapped by an outer Markdown heading", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review wrapped work-card headings",
			runRole: async ({ stage }) =>
				stage === "architecture"
					? `[L2] Wrapped work card\n\n${COMPLETE_WORK_CARD.replace(/^## /gm, "### ## ")}`
					: responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("approved");
	});

	it.each(["#", "####"])(
		"rejects a wrapped required heading with an alternate inner level (%s)",
		async (innerLevel) => {
			const result = await runAnsteelDiscussion({
				topic: "Review invalid wrapped work-card headings",
				runRole: async ({ stage }) =>
					stage === "architecture"
						? `[L2] Invalid wrapped work card\n\n${COMPLETE_WORK_CARD.replace(/^## /gm, `### ${innerLevel} `)}`
						: responseForMutualReviewStage(stage),
			});

			expect(result.verdict).toBe("rejected");
			expect(result.terminationReason).toBe("incomplete-work-card");
		},
	);

	it("accepts parenthesized qualifiers on every required revision heading", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review qualified revision headings",
			runRole: async ({ stage }) =>
				responseForMutualReviewStage(stage, {
					"architecture-revision": completeWorkCard("RESOLUTION: QA-CROSS | RESOLVED").replace(
						/^## (.+)$/gm,
						"## $1 (Revised)",
					),
				}),
		});

		expect(result.verdict).toBe("approved");
	});

	it("rejects a revision heading with an arbitrary required-section suffix", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review arbitrary revision heading suffix",
			runRole: async ({ stage }) =>
				stage === "architecture-revision"
					? completeWorkCard("RESOLUTION: QA-CROSS | RESOLVED").replace("## Conclusion", "## Conclusion notes")
					: responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("incomplete-work-card");
		expect(result.transcript.at(-1)?.stage).toBe("architecture-revision");
	});

	it("rejects a qualified revision heading with an empty body", async () => {
		const revision = completeWorkCard("RESOLUTION: QA-CROSS | RESOLVED")
			.replace(/^## (.+)$/gm, "## $1 (Revised)")
			.replace(
				"## Conclusion (Revised)\n[L2] The proposed work card is ready for peer review.",
				"## Conclusion (Revised)",
			);
		const result = await runAnsteelDiscussion({
			topic: "Review empty qualified revision heading",
			runRole: async ({ stage }) =>
				stage === "architecture-revision" ? revision : responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("incomplete-work-card");
		expect(result.markdown).toContain("missing required visible sections: Conclusion");
	});

	it("accepts an ISSUE marker in a Markdown heading", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review Markdown issue formatting",
			runRole: async ({ stage }) => {
				if (stage === "staff-cross-examination") {
					return "### ISSUE: STAFF-HEADING | TARGET: qa-engineer\nNO ISSUES | TARGET: tech-lead\nProvide a clearer invariant.";
				}
				if (stage === "qa-revision") return completeWorkCard("RESOLUTION: STAFF-HEADING | RESOLVED\n[L2] Revised.");
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("approved");
	});

	it("allows a targeted no-issues marker alongside an issue for the other peer", async () => {
		let staffCrossExaminationPrompt = "";
		const result = await runAnsteelDiscussion({
			topic: "Review per-peer cross-examination markers",
			runRole: async ({ stage, prompt }) => {
				if (stage === "staff-cross-examination") {
					staffCrossExaminationPrompt = prompt;
					return "ISSUE: STAFF-PER-PEER | TARGET: tech-lead\n### NO ISSUES | TARGET: qa-engineer\n[L2] The architecture needs a clearer invariant.";
				}
				if (stage === "architecture-revision") {
					return completeWorkCard("RESOLUTION: STAFF-PER-PEER | RESOLVED\nRESOLUTION: QA-CROSS | RESOLVED");
				}
				if (stage === "qa-revision") return completeWorkCard("[L2] No challenge is assigned to QA.");
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("approved");
		expect(staffCrossExaminationPrompt).toContain("NO ISSUES | TARGET: tech-lead");
	});

	it("rejects a cross-examination response that omits one peer", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review missing cross-examination peer coverage",
			runRole: async ({ stage }) =>
				stage === "staff-cross-examination"
					? "ISSUE: STAFF-ONLY-ONE | TARGET: tech-lead\n[L2] The interface contract is incomplete."
					: responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("invalid-challenge-ledger");
		expect(result.markdown).toContain("must cover every peer role");
	});

	it("accepts a RESOLUTION marker in a Markdown heading", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review Markdown resolution heading formatting",
			runRole: async ({ stage }) => {
				if (stage === "staff-cross-examination") {
					return "ISSUE: STAFF-RESOLUTION-HEADING | TARGET: qa-engineer\nNO ISSUES | TARGET: tech-lead";
				}
				if (stage === "qa-revision")
					return completeWorkCard("### RESOLUTION: STAFF-RESOLUTION-HEADING | RESOLVED\n[L2] Revised.");
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("approved");
	});

	it("rejects a zero-width-only role response as blank", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review zero-width role output",
			runRole: async ({ stage }) =>
				stage === "qa-verification" ? "\u200B\u200C\u200D\uFEFF" : responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("blank-response");
		expect(result.markdown).toContain("qa-engineer / qa-verification returned an empty or whitespace-only response");
	});

	it("rejects a cross-examination issue without a target role", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review an untargeted cross-examination issue",
			runRole: async ({ stage }) => {
				if (stage === "staff-cross-examination") return "ISSUE: STAFF-SHORT\nClarify the invariant";
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("invalid-challenge-ledger");
	});

	it("rejects a self-targeted cross-examination issue", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review a self-targeted challenge",
			runRole: async ({ stage }) =>
				stage === "tech-lead-cross-examination"
					? "ISSUE: TL-SELF | TARGET: tech-lead\n[L2] This must be rejected."
					: responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("invalid-challenge-ledger");
		expect(result.markdown).toContain("cannot challenge its own work card");
	});

	it("rejects a cross-examination response that combines issues with NO ISSUES", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review contradictory cross-examination markers",
			runRole: async ({ stage }) =>
				stage === "staff-cross-examination"
					? "ISSUE: STAFF-CONTRADICTION | TARGET: tech-lead\nNO ISSUES"
					: responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("invalid-challenge-ledger");
	});

	it("ignores a NO ISSUES commentary heading after valid targeted issues", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review no-issues commentary after targeted challenges",
			runRole: async ({ stage }) =>
				responseForMutualReviewStage(stage, {
					"tech-lead-cross-examination": [
						"### ISSUE: TL-COMMENT-STAFF | TARGET: staff-engineer",
						"### ISSUE: TL-COMMENT-QA | TARGET: qa-engineer",
						"### NO ISSUES (remaining claims)",
					].join("\n"),
					"staff-revision": completeWorkCard("RESOLUTION: TL-COMMENT-STAFF | RESOLVED"),
					"qa-revision": completeWorkCard(
						"RESOLUTION: STAFF-CROSS | RESOLVED\nRESOLUTION: TL-COMMENT-QA | RESOLVED",
					),
				}),
		});

		expect(result.verdict).toBe("approved");
		expect(result.challengeLedger).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "TL-COMMENT-STAFF", targetRole: "staff-engineer", status: "resolved" }),
				expect.objectContaining({ id: "TL-COMMENT-QA", targetRole: "qa-engineer", status: "resolved" }),
			]),
		);
	});

	it("does not let NO ISSUES commentary cover an unchallenged peer", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review unchallenged peer after no-issues commentary",
			runRole: async ({ stage }) =>
				stage === "tech-lead-cross-examination"
					? "ISSUE: TL-COMMENT-ONLY | TARGET: staff-engineer\nNO ISSUES: QA claims are already covered above."
					: responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("invalid-challenge-ledger");
		expect(result.markdown).toContain("must cover every peer role with an ISSUE or targeted NO ISSUES marker");
	});

	it("rejects a bold RESOLUTION marker embedded in prose", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review embedded Markdown resolution formatting",
			runRole: async ({ stage }) => {
				if (stage === "staff-cross-examination") {
					return "ISSUE: STAFF-TABLE | TARGET: qa-engineer\nNO ISSUES | TARGET: tech-lead\nClarify the boundary.";
				}
				if (stage === "qa-revision")
					return completeWorkCard("The summary says **RESOLUTION: STAFF-TABLE | RESOLVED**.");
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("unanswered-challenge");
		expect(result.transcript.at(-1)?.stage).toBe("qa-revision");
	});

	it("accepts an emphasized verification verdict", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review Markdown verdict formatting",
			runRole: async ({ stage }) =>
				responseForMutualReviewStage(stage, {
					"staff-verification": "**VERDICT: APPROVE**",
				}),
		});

		expect(result.verdict).toBe("approved");
	});

	it("bounds each role stage to a finite number of safe tool executions", () => {
		const budget = createAnsteelToolBudget(2);

		expect(budget.beforeToolCall("read", { path: "src/main.ts" })).toBeUndefined();
		expect(budget.beforeToolCall("find", { pattern: "*.ts" })).toBeUndefined();
		expect(budget.beforeToolCall("grep", { pattern: "TODO" })).toEqual({
			block: true,
			reason:
				"Ansteel stage tool budget of 2 executions is exhausted. Provide the evidence-labelled conclusion without requesting more tools.",
		});
		expect(budget.getStageFailureReason()).toBeUndefined();

		budget.reset();
		expect(budget.beforeToolCall("bash", { command: "npm test" })).toEqual({
			block: true,
			reason: "Ansteel bash requires an explicit timeout of at most 20 seconds.",
		});
		expect(budget.getStageFailureReason()).toBeUndefined();
		expect(budget.beforeToolCall("bash", { command: "npm test", timeout: 21 })).toEqual({
			block: true,
			reason: "Ansteel bash requires an explicit timeout of at most 20 seconds.",
		});
		expect(budget.getStageFailureReason()).toBeUndefined();
		expect(budget.beforeToolCall("bash", { command: "npm test", timeout: 20 })).toEqual({
			block: true,
			reason:
				"Ansteel stage tool budget of 2 executions is exhausted. Provide the evidence-labelled conclusion without requesting more tools.",
		});
		expect(budget.getStageFailureReason()).toBeUndefined();

		budget.reset();
		expect(budget.getStageFailureReason()).toBeUndefined();
		expect(budget.beforeToolCall("bash", { command: "npm test", timeout: 20 })).toBeUndefined();
	});

	it("blocks all tool execution during the one permitted format repair", () => {
		const budget = createAnsteelToolBudget(4);

		budget.reset({ toolsEnabled: false });

		expect(budget.beforeToolCall("read", { path: "src/main.ts" })).toEqual({
			block: true,
			reason: "Ansteel format repair permits no tool executions. Correct only the required response markers.",
		});
		expect(budget.getStageFailureReason()).toBeUndefined();
	});

	it("rejects a QA challenge that uses the Staff Engineer issue namespace", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review role-specific challenge namespaces",
			runRole: async ({ stage }) =>
				stage === "qa-cross-examination"
					? "ISSUE: STAFF-1 | TARGET: tech-lead\nNO ISSUES | TARGET: staff-engineer"
					: responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("invalid-challenge-ledger");
		expect(result.transcript.at(-1)?.stage).toBe("qa-cross-examination");
		expect(result.markdown).toContain("qa-engineer challenge STAFF-1 must use issue IDs beginning with QA-");
	});

	it("permits exactly one no-tool format repair for a namespace-invalid QA challenge", async () => {
		const calls: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage; formatRepair?: true }> = [];

		const result = await runAnsteelDiscussion({
			topic: "Repair a namespace-invalid QA challenge",
			runRole: async ({ role, stage, formatRepair }) => {
				calls.push({ role, stage, formatRepair });
				if (role === "qa-engineer" && stage === "qa-cross-examination") {
					return formatRepair
						? "ISSUE: QA-CROSS | TARGET: tech-lead\nNO ISSUES | TARGET: staff-engineer"
						: "ISSUE: STAFF-CROSS | TARGET: tech-lead\nNO ISSUES | TARGET: staff-engineer";
				}
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("approved");
		expect(calls.filter((call) => call.role === "qa-engineer" && call.stage === "qa-cross-examination")).toEqual([
			{ role: "qa-engineer", stage: "qa-cross-examination" },
			{ role: "qa-engineer", stage: "qa-cross-examination", formatRepair: true },
		]);
		expect(result.transcript.filter((entry) => entry.formatRepair)).toEqual([
			expect.objectContaining({ role: "qa-engineer", stage: "qa-cross-examination", formatRepair: true }),
		]);
	});

	it("reads only the raw assistant text created by the current prompt", async () => {
		const messages: RawTurnMessage[] = [
			{
				role: "assistant",
				content: [{ type: "text", text: "VERDICT: APPROVE" }],
				stopReason: "stop",
			},
		];
		const assistantMessages = createAssistantMessageEmitter();
		const source: RawTurnSessionSource = {
			messages,
			prompt: async () => {
				const response: RawTurnMessage = {
					role: "assistant",
					content: [
						{ type: "text", text: "VERDICT: " },
						{ type: "text", text: "APPROVE " },
					],
					stopReason: "stop",
				};
				messages.push(response);
				assistantMessages.emit(response);
			},
			subscribeToAssistantMessageEnd: assistantMessages.subscribe,
			dispose: () => {},
		};

		const session = createAnsteelRawTurnSession(source);

		const response = await session.prompt("veto");

		expect(getLegacyCopyText(messages)).toBe("VERDICT: APPROVE");
		expect(response).toBe("VERDICT: APPROVE ");
	});

	it("forwards the raw session abort hook", async () => {
		let aborts = 0;
		const session = createAnsteelRawTurnSession({
			prompt: async () => {},
			subscribeToAssistantMessageEnd: () => () => {},
			abort: () => {
				aborts++;
			},
			dispose: () => {},
		});

		expect(session.abort).toBeDefined();
		await session.abort?.();
		expect(aborts).toBe(1);
	});

	it("captures the current assistant event when compaction replaces the message list", async () => {
		let messages: RawTurnMessage[] = [
			{ role: "user", content: [{ type: "text", text: "old request" }] },
			{ role: "assistant", content: [{ type: "text", text: "old response" }] },
		];
		const assistantMessages = createAssistantMessageEmitter();
		const source: RawTurnSessionSource = {
			get messages() {
				return messages;
			},
			prompt: async () => {
				assistantMessages.emit({
					role: "assistant",
					content: [{ type: "text", text: "[L1] Current evidence before compaction" }],
				});
				messages = [{ role: "assistant", content: [{ type: "text", text: "compacted history" }] }];
			},
			subscribeToAssistantMessageEnd: assistantMessages.subscribe,
			dispose: () => {},
		};

		const response = await createAnsteelRawTurnSession(source).prompt("verify evidence");

		expect(response).toBe("[L1] Current evidence before compaction");
	});

	it("uses the final assistant message emitted during a prompt", async () => {
		const assistantMessages = createAssistantMessageEmitter();
		const source: RawTurnSessionSource = {
			messages: [],
			prompt: async () => {
				assistantMessages.emit({
					role: "assistant",
					content: [{ type: "text", text: "[L3] First tool-loop response" }],
				});
				assistantMessages.emit({
					role: "assistant",
					content: [{ type: "text", text: "[L1] Final verified response " }],
				});
			},
			subscribeToAssistantMessageEnd: assistantMessages.subscribe,
			dispose: () => {},
		};

		const response = await createAnsteelRawTurnSession(source).prompt("verify evidence");

		expect(response).toBe("[L1] Final verified response ");
	});

	it("records a stage audit trail with tool lifecycle events", async () => {
		const assistantMessages = createAssistantMessageEmitter();
		const agentEvents = createAgentEventEmitter();
		const session = createAnsteelRawTurnSession({
			prompt: async () => {
				agentEvents.emit({
					type: "tool_execution_start",
					toolCallId: "read-1",
					toolName: "read",
					args: { path: "src/main.ts" },
				});
				agentEvents.emit({
					type: "tool_execution_end",
					toolCallId: "read-1",
					toolName: "read",
					result: { content: [] },
					isError: false,
				});
				assistantMessages.emit({
					role: "assistant",
					content: [{ type: "text", text: "[L1] Evidence reviewed" }],
					stopReason: "stop",
				});
			},
			subscribeToAssistantMessageEnd: assistantMessages.subscribe,
			subscribeToAgentEvent: agentEvents.subscribe,
			dispose: () => {},
		});

		await session.prompt("review evidence");

		const auditableSession = session as typeof session & {
			getLastStageAudit?: () => { events: Array<Record<string, unknown>> };
		};
		expect(auditableSession.getLastStageAudit?.()).toEqual({
			events: [
				expect.objectContaining({ type: "stage-prompt-start" }),
				expect.objectContaining({ type: "tool-execution-start", toolName: "read" }),
				expect.objectContaining({ type: "tool-execution-end", toolName: "read", isError: false }),
				expect.objectContaining({ type: "assistant-message-end", stopReason: "stop" }),
				expect.objectContaining({ type: "stage-prompt-end" }),
			],
		});
	});

	it("does not reuse an older assistant message when no current assistant event is emitted", async () => {
		const assistantMessages = createAssistantMessageEmitter();
		const source: RawTurnSessionSource = {
			messages: [{ role: "assistant", content: [{ type: "text", text: "VERDICT: APPROVE" }] }],
			prompt: async () => {},
			subscribeToAssistantMessageEnd: assistantMessages.subscribe,
			dispose: () => {},
		};

		const response = await createAnsteelRawTurnSession(source).prompt("veto");

		expect(response).toBe("");
	});

	it("surfaces a redacted provider error instead of treating it as an empty role reply", async () => {
		const assistantMessages = createAssistantMessageEmitter();
		const session = createAnsteelRawTurnSession({
			prompt: async () => {
				assistantMessages.emit({
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "Provider rejected Authorization: Bearer top-secret-token",
				});
			},
			subscribeToAssistantMessageEnd: assistantMessages.subscribe,
			dispose: () => {},
		});

		await expect(session.prompt("inspect failure")).rejects.toThrow(
			"Ansteel role provider error: Provider rejected Authorization: Bearer [REDACTED]",
		);
		const audit = session.getLastStageAudit?.();
		expect(audit?.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "assistant-message-end", stopReason: "error" }),
				expect.objectContaining({ type: "stage-prompt-error" }),
			]),
		);
		expect(audit?.events).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "stage-prompt-end" })]),
		);
	});

	it("attempts every raw-session listener cleanup after one cleanup fails", async () => {
		let agentEventUnsubscribes = 0;
		const assistantMessages = createAssistantMessageEmitter();
		const session = createAnsteelRawTurnSession({
			prompt: async () => {
				assistantMessages.emit({
					role: "assistant",
					content: [{ type: "text", text: "[L1] Evidence" }],
					stopReason: "stop",
				});
			},
			subscribeToAssistantMessageEnd: (listener) => {
				const unsubscribe = assistantMessages.subscribe(listener);
				return () => {
					unsubscribe();
					throw new Error("assistant listener cleanup failed");
				};
			},
			subscribeToAgentEvent: () => () => {
				agentEventUnsubscribes++;
			},
			dispose: () => {},
		});

		await expect(session.prompt("verify cleanup")).rejects.toThrow("assistant listener cleanup failed");
		expect(agentEventUnsubscribes).toBe(1);
	});

	it("redacts thrown role failures before they reach the discussion report", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Redact provider failure",
			runRole: async () => {
				throw new Error("Provider rejected Authorization: Bearer sk-unit-test-provider-secret");
			},
		});

		expect(result.failure?.reason).toBe("Provider rejected Authorization: Bearer [REDACTED]");
		expect(result.markdown).toContain("Bearer [REDACTED]");
		expect(result.markdown).not.toContain("sk-unit-test-provider-secret");
	});

	it("unsubscribes a failed prompt listener before a later stage emits an assistant message", async () => {
		const listeners = new Set<(message: unknown) => void>();
		const deliveryCounts = new Map<number, number>();
		let promptCount = 0;
		let subscriptionCount = 0;
		let unsubscribeCalls = 0;
		const emitAssistantMessage = (message: RawTurnMessage): void => {
			for (const listener of listeners) listener(message);
		};
		const source: RawTurnSessionSource = {
			messages: [],
			prompt: async () => {
				promptCount++;
				if (promptCount === 1) throw new Error("source prompt failed");
				emitAssistantMessage({
					role: "assistant",
					content: [{ type: "text", text: "[L1] Later-stage evidence" }],
				});
			},
			subscribeToAssistantMessageEnd: (listener) => {
				const subscription = subscriptionCount++;
				deliveryCounts.set(subscription, 0);
				const trackedListener = (message: unknown): void => {
					deliveryCounts.set(subscription, (deliveryCounts.get(subscription) ?? 0) + 1);
					listener(message);
				};
				listeners.add(trackedListener);
				return () => {
					unsubscribeCalls++;
					listeners.delete(trackedListener);
				};
			},
			dispose: () => {},
		};

		const session = createAnsteelRawTurnSession(source);

		await expect(session.prompt("failed stage")).rejects.toThrow("source prompt failed");
		expect(await session.prompt("later stage")).toBe("[L1] Later-stage evidence");
		expect(unsubscribeCalls).toBe(2);
		expect(listeners.size).toBe(0);
		expect(deliveryCounts.get(0)).toBe(0);
		expect(deliveryCounts.get(1)).toBe(1);
	});

	it("keeps the provider failure primary when raw listener cleanup also fails", async () => {
		type TestModel = { provider: string; id: string };
		const promptedRoles: AnsteelRole[] = [];
		const disposed: AnsteelRole[] = [];

		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review a raw provider failure",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => {
				if (role === "tech-lead") {
					return createAnsteelRawTurnSession({
						prompt: async () => {
							promptedRoles.push(role);
							throw new Error("provider request failed");
						},
						subscribeToAssistantMessageEnd: () => () => {
							throw new Error("listener cleanup failed");
						},
						dispose: () => {
							disposed.push(role);
						},
					});
				}

				return {
					prompt: async () => {
						promptedRoles.push(role);
						throw new Error(`Unexpected prompt for ${role}`);
					},
					dispose: () => {
						disposed.push(role);
					},
				};
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.failure).toEqual({
			role: "tech-lead",
			stage: "architecture",
			reason: "provider request failed; listener cleanup also failed: listener cleanup failed",
		});
		expect(result.transcript).toEqual([]);
		expect(promptedRoles).toEqual(["tech-lead"]);
		expect(disposed).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
	});

	it("rejects and archives listener cleanup failure after a successful raw prompt", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review listener cleanup failure",
			runRole: async ({ role, stage, prompt }) => {
				if (role !== "tech-lead" || stage !== "architecture") {
					throw new Error(`Unexpected ${role} / ${stage}`);
				}

				return await createAnsteelRawTurnSession({
					prompt: async () => {},
					subscribeToAssistantMessageEnd: () => () => {
						throw new Error("listener cleanup failed");
					},
					dispose: () => {},
				}).prompt(prompt);
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.failure).toEqual({
			role: "tech-lead",
			stage: "architecture",
			reason: "listener cleanup failed",
		});
		expect(result.transcript).toEqual([]);
		expect(result.markdown).toContain("- Reason: listener cleanup failed");
	});

	it("stops project review when the current QA reply is empty instead of reusing an earlier reply", async () => {
		type TestModel = { provider: string; id: string };
		const prompts: Array<{ role: AnsteelRole; text: string }> = [];
		let qaMessages: RawTurnMessage[] | undefined;

		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review current QA turn",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => {
				const assistantMessages = createAssistantMessageEmitter();
				const messages: RawTurnMessage[] =
					role === "qa-engineer"
						? [
								{
									role: "assistant",
									content: [{ type: "text", text: "VERDICT: APPROVE" }],
									stopReason: "stop",
								},
							]
						: [];
				if (role === "qa-engineer") qaMessages = messages;
				return createAnsteelRawTurnSession({
					prompt: async (text) => {
						prompts.push({ role, text });
						const stage = getStageFromPrompt(text);
						const response: RawTurnMessage =
							stage === "qa-verification"
								? { role: "assistant", content: [], stopReason: "aborted" }
								: { role: "assistant", content: [{ type: "text", text: responseForMutualReviewStage(stage) }] };
						messages.push(response);
						assistantMessages.emit(response);
					},
					subscribeToAssistantMessageEnd: assistantMessages.subscribe,
					dispose: () => {},
				});
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(result.transcript.at(-1)?.response).toBe("");
		expect(getLegacyCopyText(qaMessages ?? [])).toBe(MUTUAL_REVIEW_RESPONSES["qa-revision"]);
		expect(result.markdown).toContain("qa-engineer / qa-verification returned an empty or whitespace-only response");
		expect(prompts.some(({ text }) => text.includes("Current stage: consensus."))).toBe(false);
	});

	it("runs three independent work cards, cross-examination, and three-role verification before consensus", async () => {
		const calls: Array<{ role: AnsteelRole; stage: string; prompt: string }> = [];
		const techCard = completeWorkCard(
			"[L2] Tech work card: component boundaries, failure policy, and acceptance criteria",
		);
		const staffCard = completeWorkCard("[L2] Staff work card: implementation sequencing and interface constraints");
		const qaCard = completeWorkCard("[L2] QA work card: test oracle and fault-injection plan");

		const result = await runAnsteelDiscussion({
			topic: "Review the motor safety architecture",
			runRole: async ({ role, stage, prompt }) => {
				calls.push({ role, stage, prompt });
				switch (stage) {
					case "architecture":
						return techCard;
					case "staff-critique":
						return staffCard;
					case "qa-critique":
						return qaCard;
					case "tech-lead-cross-examination":
						return "ISSUE: TL-1 | TARGET: staff-engineer\nNO ISSUES | TARGET: qa-engineer\n[L2] The driver interface cannot meet the proposed timing.";
					case "staff-cross-examination":
						return "ISSUE: STAFF-1 | TARGET: qa-engineer\nNO ISSUES | TARGET: tech-lead\n[L2] The fault-injection acceptance test is missing.";
					case "qa-cross-examination":
						return "ISSUE: QA-1 | TARGET: tech-lead\nNO ISSUES | TARGET: staff-engineer\n[L2] The architecture lacks a failure boundary.";
					case "architecture-revision":
						return completeWorkCard("RESOLUTION: QA-1 | RESOLVED");
					case "staff-revision":
						return completeWorkCard("RESOLUTION: TL-1 | RESOLVED");
					case "qa-revision":
						return completeWorkCard("RESOLUTION: STAFF-1 | RESOLVED");
					case "tech-lead-verification":
						return "VERDICT: APPROVE\nTL-VERIFICATION-PRIVATE";
					case "staff-verification":
						return "VERDICT: APPROVE\nSTAFF-VERIFICATION-PRIVATE";
					case "qa-verification":
						return "VERDICT: APPROVE\nQA-VERIFICATION-PRIVATE";
					case "staff-sign-off":
					case "qa-sign-off":
						return "VERDICT: APPROVE";
					case "consensus":
						return "[L1] Immutable architecture consensus";
					default:
						return `[L2] ${role}/${stage}`;
				}
			},
		});

		expect(result.verdict).toBe("approved");
		expect(calls.map(({ role, stage }) => `${role}:${stage}`)).toEqual(
			MUTUAL_REVIEW_STAGE_ORDER.map(({ role, stage }) => `${role}:${stage}`),
		);

		const staffCritiquePrompt = calls.find((call) => call.stage === "staff-critique")?.prompt ?? "";
		const qaCritiquePrompt = calls.find((call) => call.stage === "qa-critique")?.prompt ?? "";
		const staffCrossExaminationPrompt = calls.find((call) => call.stage === "staff-cross-examination")?.prompt ?? "";
		const architectureRevisionPrompt = calls.find((call) => call.stage === "architecture-revision")?.prompt ?? "";
		const staffRevisionPrompt = calls.find((call) => call.stage === "staff-revision")?.prompt ?? "";
		const techLeadVerificationPrompt = calls.find((call) => call.stage === "tech-lead-verification")?.prompt ?? "";
		const staffVerificationPrompt = calls.find((call) => call.stage === "staff-verification")?.prompt ?? "";
		const qaVerificationPrompt = calls.find((call) => call.stage === "qa-verification")?.prompt ?? "";
		expect(staffCritiquePrompt).not.toContain(techCard);
		expect(qaCritiquePrompt).not.toContain(techCard);
		expect(staffCritiquePrompt).toContain("no leading or trailing whitespace");
		expect(staffCritiquePrompt).toContain("Never repeat an `ISSUE:` marker");
		expect(staffCritiquePrompt).toContain("Do not read or cite prior Ansteel reports");
		expect(staffCrossExaminationPrompt).toContain(techCard);
		expect(staffCrossExaminationPrompt).toContain(staffCard);
		expect(staffCrossExaminationPrompt).toContain(qaCard);
		expect(architectureRevisionPrompt).toContain("The architecture lacks a failure boundary.");
		expect(staffRevisionPrompt).toContain("The driver interface cannot meet the proposed timing.");
		for (const verificationPrompt of [techLeadVerificationPrompt, staffVerificationPrompt, qaVerificationPrompt]) {
			expect(verificationPrompt).toContain("RESOLUTION: TL-1 | RESOLVED");
			expect(verificationPrompt).toContain("RESOLUTION: STAFF-1 | RESOLVED");
			expect(verificationPrompt).toContain("RESOLUTION: QA-1 | RESOLVED");
			expect(verificationPrompt).toContain("TL-1 | tech-lead -> staff-engineer | round 0 | resolved");
			expect(verificationPrompt).toContain(
				"The final nonblank line of your response must be exactly `VERDICT: APPROVE` or exactly `VERDICT: REJECT`.",
			);
			expect(verificationPrompt).toContain(
				"If you reject, add at least one new targeted `ISSUE: <ID> | TARGET: <role>` marker before that final verdict line.",
			);
		}
		expect(qaVerificationPrompt).not.toContain("STAFF-VERIFICATION-PRIVATE");
	});

	it("returns verifier rejections to a second collaborative revision before rejecting at the cap", async () => {
		const calls: Array<{ role: AnsteelRole; stage: string }> = [];
		let revisionCount = 0;

		const result = await runAnsteelDiscussion({
			topic: "Review repeated architecture objections",
			runRole: async ({ role, stage }) => {
				calls.push({ role, stage });
				switch (stage) {
					case "architecture-revision":
						revisionCount++;
						return completeWorkCard(
							revisionCount === 1 ? "RESOLUTION: QA-CROSS | RESOLVED" : "[L2] No new Tech Lead challenge.",
						);
					case "staff-revision":
						return completeWorkCard(
							revisionCount === 1 ? "RESOLUTION: TL-CROSS | RESOLVED" : "RESOLUTION: QA-VERIFY-1 | RESOLVED",
						);
					case "qa-revision":
						return completeWorkCard(
							revisionCount === 1 ? "RESOLUTION: STAFF-CROSS | RESOLVED" : "[L2] No new QA challenge.",
						);
					case "qa-verification":
						return `VERDICT: REJECT\nISSUE: QA-VERIFY-${revisionCount} | TARGET: staff-engineer\n[L1] The safety test still cannot prove the fault path.`;
					default:
						return responseForMutualReviewStage(stage);
				}
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(calls.filter((call) => call.stage === "architecture-revision")).toHaveLength(2);
		expect(calls.map(({ role, stage }) => `${role}:${stage}`)).not.toContain("tech-lead:consensus");
		expect(result.markdown).toContain("maximum of 2 revision rounds");
	});

	it("rejects an architecture revision that does not answer every challenge ID", async () => {
		const calls: Array<{ role: AnsteelRole; stage: string }> = [];

		const result = await runAnsteelDiscussion({
			topic: "Review unresolved architecture challenge",
			runRole: async ({ role, stage }) => {
				calls.push({ role, stage });
				switch (stage) {
					case "architecture":
						return completeWorkCard("[L1] Architecture v0");
					case "staff-critique":
						return completeWorkCard("ISSUE: STAFF-UNANSWERED\n[L2] Driver ownership is ambiguous.");
					case "qa-critique":
						return completeWorkCard("ISSUE: QA-ANSWERED\n[L2] Error-path coverage is incomplete.");
					case "architecture-revision":
						return completeWorkCard("RESOLUTION: QA-ANSWERED | RESOLVED");
					default:
						return `[L2] ${role}/${stage}`;
				}
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.markdown).toContain("STAFF-UNANSWERED");
		expect(calls.map(({ role, stage }) => `${role}:${stage}`)).not.toContain("staff-engineer:staff-verification");
	});

	it("allows independent reviewers to record NO ISSUES", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review an architecture without objections",
			runRole: async ({ stage }) =>
				responseForMutualReviewStage(stage, {
					"tech-lead-cross-examination": "NO ISSUES",
					"staff-cross-examination": "NO ISSUES",
					"qa-cross-examination": "NO ISSUES",
					"architecture-revision": completeWorkCard(
						"[L2] Tech Lead work card remains unchanged after independent review.",
					),
					"staff-revision": completeWorkCard("[L2] Staff work card remains unchanged after independent review."),
					"qa-revision": completeWorkCard("[L2] QA work card remains unchanged after independent review."),
				}),
		});

		expect(result.verdict).toBe("approved");
		expect(result.challengeLedger).toEqual([]);
		expect(result.markdown).toContain("No recorded challenge IDs.");
	});

	it("tolerates a redundant targeted NO ISSUES marker without discarding peer challenges", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review redundant targeted no-issues commentary",
			runRole: async ({ stage }) =>
				responseForMutualReviewStage(stage, {
					"staff-cross-examination": [
						"ISSUE: STAFF-REDUNDANT-1 | TARGET: tech-lead",
						"ISSUE: STAFF-REDUNDANT-2 | TARGET: tech-lead",
						"ISSUE: STAFF-REDUNDANT-3 | TARGET: qa-engineer",
						"NO ISSUES | TARGET: tech-lead",
					].join("\n"),
					"architecture-revision": completeWorkCard(
						"RESOLUTION: QA-CROSS | RESOLVED\nRESOLUTION: STAFF-REDUNDANT-1 | RESOLVED\nRESOLUTION: STAFF-REDUNDANT-2 | RESOLVED",
					),
					"qa-revision": completeWorkCard("RESOLUTION: STAFF-REDUNDANT-3 | RESOLVED"),
				}),
		});

		expect(result.verdict).toBe("approved");
		expect(result.challengeLedger).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "STAFF-REDUNDANT-1", targetRole: "tech-lead", status: "resolved" }),
				expect.objectContaining({ id: "STAFF-REDUNDANT-2", targetRole: "tech-lead", status: "resolved" }),
				expect.objectContaining({ id: "STAFF-REDUNDANT-3", targetRole: "qa-engineer", status: "resolved" }),
			]),
		);
	});

	it("accepts exact whole-line inline-code cross-examination and resolution markers", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review inline-code Ansteel markers",
			runRole: async ({ stage }) =>
				responseForMutualReviewStage(stage, {
					"tech-lead-cross-examination":
						"`ISSUE: TL-INLINE | TARGET: staff-engineer`\n`NO ISSUES | TARGET: qa-engineer`",
					"staff-cross-examination":
						"`ISSUE: STAFF-INLINE | TARGET: qa-engineer`\n`NO ISSUES | TARGET: tech-lead`",
					"qa-cross-examination": "`ISSUE: QA-INLINE | TARGET: tech-lead`\n`NO ISSUES | TARGET: staff-engineer`",
					"architecture-revision": completeWorkCard("`RESOLUTION: QA-INLINE | RESOLVED`"),
					"staff-revision": completeWorkCard("`RESOLUTION: TL-INLINE | RESOLVED`"),
					"qa-revision": completeWorkCard("`RESOLUTION: STAFF-INLINE | RESOLVED`"),
				}),
		});

		expect(result.verdict).toBe("approved");
		expect(result.challengeLedger).toEqual([
			expect.objectContaining({ id: "TL-INLINE", targetRole: "staff-engineer", status: "resolved" }),
			expect.objectContaining({ id: "STAFF-INLINE", targetRole: "qa-engineer", status: "resolved" }),
			expect.objectContaining({ id: "QA-INLINE", targetRole: "tech-lead", status: "resolved" }),
		]);
	});

	it("accepts an exact whole-line inline-code plain NO ISSUES marker", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review inline-code no-issues markers",
			runRole: async ({ stage }) =>
				responseForMutualReviewStage(stage, {
					"tech-lead-cross-examination": "`NO ISSUES`",
					"staff-cross-examination": "`NO ISSUES`",
					"qa-cross-examination": "`NO ISSUES`",
					"architecture-revision": completeWorkCard("[L2] No Tech Lead revision is required."),
					"staff-revision": completeWorkCard("[L2] No Staff revision is required."),
					"qa-revision": completeWorkCard("[L2] No QA revision is required."),
				}),
		});

		expect(result.verdict).toBe("approved");
		expect(result.challengeLedger).toEqual([]);
	});

	it("accepts exact whole-line bold cross-examination and resolution markers", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review bold Ansteel markers",
			runRole: async ({ stage }) =>
				responseForMutualReviewStage(stage, {
					"tech-lead-cross-examination":
						"**ISSUE: TL-BOLD | TARGET: staff-engineer**\n**NO ISSUES | TARGET: qa-engineer**",
					"staff-cross-examination":
						"**ISSUE: STAFF-BOLD | TARGET: qa-engineer**\n**NO ISSUES | TARGET: tech-lead**",
					"qa-cross-examination": "**ISSUE: QA-BOLD | TARGET: tech-lead**\n**NO ISSUES | TARGET: staff-engineer**",
					"architecture-revision": completeWorkCard("**RESOLUTION: QA-BOLD | RESOLVED**"),
					"staff-revision": completeWorkCard("**RESOLUTION: TL-BOLD | RESOLVED**"),
					"qa-revision": completeWorkCard("**RESOLUTION: STAFF-BOLD | RESOLVED**"),
				}),
		});

		expect(result.verdict).toBe("approved");
		expect(result.challengeLedger).toEqual([
			expect.objectContaining({ id: "TL-BOLD", targetRole: "staff-engineer", status: "resolved" }),
			expect.objectContaining({ id: "STAFF-BOLD", targetRole: "qa-engineer", status: "resolved" }),
			expect.objectContaining({ id: "QA-BOLD", targetRole: "tech-lead", status: "resolved" }),
		]);
	});

	it.each([
		[
			"a bold marker embedded in prose",
			"The review says **ISSUE: TL-EMBEDDED-BOLD | TARGET: staff-engineer** and **NO ISSUES | TARGET: qa-engineer**.",
		],
		[
			"partially wrapped bold markers",
			"**ISSUE: TL-PARTIAL-BOLD | TARGET: staff-engineer\nNO ISSUES | TARGET: qa-engineer**",
		],
	])("rejects %s during cross-examination", async (_description, response) => {
		const result = await runAnsteelDiscussion({
			topic: "Reject non-whole-line bold markers",
			runRole: async ({ stage }) =>
				stage === "tech-lead-cross-examination" ? response : responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("invalid-challenge-ledger");
		expect(result.transcript.at(-1)?.stage).toBe("tech-lead-cross-examination");
	});

	it("rejects inline-code markers embedded in prose", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Reject embedded inline-code markers",
			runRole: async ({ stage }) =>
				responseForMutualReviewStage(stage, {
					"tech-lead-cross-examination":
						"The review says `ISSUE: TL-EMBEDDED | TARGET: staff-engineer` and `NO ISSUES | TARGET: qa-engineer`.",
					"staff-cross-examination":
						"The review says `ISSUE: STAFF-EMBEDDED | TARGET: qa-engineer` and `NO ISSUES | TARGET: tech-lead`.",
					"qa-cross-examination":
						"The review says `ISSUE: QA-EMBEDDED | TARGET: tech-lead` and `NO ISSUES | TARGET: staff-engineer`.",
					"architecture-revision": completeWorkCard("The review says `RESOLUTION: QA-EMBEDDED | RESOLVED`."),
					"staff-revision": completeWorkCard("The review says `RESOLUTION: TL-EMBEDDED | RESOLVED`."),
					"qa-revision": completeWorkCard("The review says `RESOLUTION: STAFF-EMBEDDED | RESOLVED`."),
				}),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("invalid-challenge-ledger");
		expect(result.transcript.at(-1)?.stage).toBe("tech-lead-cross-examination");
	});

	it("rejects a resolution marker embedded in inline-code prose", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Reject embedded inline-code resolutions",
			runRole: async ({ stage }) =>
				responseForMutualReviewStage(stage, {
					"staff-revision": completeWorkCard(
						"The revision says `RESOLUTION: TL-CROSS | RESOLVED`, but does not provide a whole-line marker.",
					),
				}),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("unanswered-challenge");
		expect(result.transcript.at(-1)?.stage).toBe("staff-revision");
		expect(result.markdown).toContain("did not answer open challenge IDs: TL-CROSS");
	});

	it.each([
		["a trailing space on an issue marker", "ISSUE: STAFF-STRICT "],
		["a trailing space on the no-issues marker", "NO ISSUES "],
	])("rejects %s before the collaborative revision", async (_description, staffCritique) => {
		const result = await runAnsteelDiscussion({
			topic: "Review strict challenge marker parsing",
			runRole: async ({ stage }) =>
				stage === "staff-cross-examination" ? staffCritique : responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("invalid-challenge-ledger");
		expect(result.transcript.at(-1)?.stage).toBe("staff-cross-examination");
	});

	it("rejects a resolution marker with trailing whitespace before verification", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review strict resolution marker parsing",
			runRole: async ({ stage }) =>
				stage === "staff-revision"
					? completeWorkCard("RESOLUTION: TL-CROSS | RESOLVED ")
					: responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("unanswered-challenge");
		expect(result.transcript.at(-1)?.stage).toBe("staff-revision");
	});

	it("rejects a verification rejection that does not add a new issue", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review an unsupported verification rejection",
			runRole: async ({ stage }) =>
				stage === "qa-verification" ? "VERDICT: REJECT\nNO ISSUES" : responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(result.terminationReason).toBe("invalid-challenge-ledger");
		expect(result.markdown).toContain("qa-engineer rejected the revised work cards without adding a new ISSUE line");
	});

	it("returns a targeted QA verification rejection to a second collaborative revision before consensus", async () => {
		const calls: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage; round?: number }> = [];

		const result = await runAnsteelDiscussion({
			topic: "Review the motor safety change",
			runRole: async ({ role, stage, round }) => {
				calls.push({ role, stage, round });
				if (stage === "qa-verification" && round === 1) {
					return "VERDICT: REJECT\nISSUE: QA-VERIFICATION-1 | TARGET: staff-engineer\n[L1] The safety test is absent.";
				}
				if (stage === "staff-revision" && round === 2) {
					return completeWorkCard("RESOLUTION: QA-VERIFICATION-1 | RESOLVED");
				}
				if ((stage === "architecture-revision" || stage === "qa-revision") && round === 2) {
					return completeWorkCard("[L2] No newly assigned challenge.");
				}
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("approved");
		expect(result.revisionRounds).toEqual([
			{
				round: 1,
				techLeadVerdict: "approved",
				staffVerdict: "approved",
				qaVerdict: "rejected",
				outcome: "needs-revision",
			},
			{
				round: 2,
				techLeadVerdict: "approved",
				staffVerdict: "approved",
				qaVerdict: "approved",
				outcome: "approved",
			},
		]);
		expect(calls.filter((call) => call.stage === "staff-revision")).toHaveLength(2);
		expect(calls.map(({ role, stage }) => `${role}:${stage}`)).toContain("tech-lead:consensus");
		expect(result.markdown).toContain("QA-VERIFICATION-1");
	});

	it("rejects a bare QA verification issue before another revision", async () => {
		const calls: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage; round?: number }> = [];

		const result = await runAnsteelDiscussion({
			topic: "Review an unassigned verification issue",
			runRole: async ({ role, stage, round }) => {
				calls.push({ role, stage, round });
				if (stage === "qa-verification" && round === 1) return "VERDICT: REJECT\nISSUE: QA-BARE";
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("invalid-challenge-ledger");
		expect(calls.some((call) => call.round === 2)).toBe(false);
		expect(calls.map(({ role, stage }) => `${role}:${stage}`)).not.toContain("tech-lead:consensus");
	});

	it("runs consensus only after independent verification and keeps the discussion transcript", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review the parser",
			runRole: async ({ stage }) =>
				responseForMutualReviewStage(stage, {
					architecture: completeWorkCard("[L1] Tech Lead parser work card"),
					"qa-verification":
						"[L2] Conditions met before the decision\nVERDICT: APPROVE\n[L2] Follow-up remains after the decision",
					consensus: "[L2] Consensus ",
				}),
		});

		expect(result.verdict).toBe("approved");
		expect(result.consensus).toBe("[L2] Consensus ");
		expect(result.markdown).toContain("[L1] Tech Lead parser work card");
		expect(result.markdown).toContain("TL-CROSS");
		expect(result.markdown).toContain("STAFF-CROSS");
		expect(result.markdown).toContain("QA-CROSS");
		expect(result.markdown).toContain("## Tech Lead Consensus\n\n[L2] Consensus \n");
	});

	it("gives consensus and final sign-offs the same coordinator-generated ledger summary", async () => {
		const prompts = new Map<AnsteelDiscussionStage, string>();

		const result = await runAnsteelDiscussion({
			topic: "Review immutable ledger summary delivery",
			runRole: async ({ stage, prompt }) => {
				prompts.set(stage, prompt);
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("approved");
		expect(result.immutableLedgerSummary).toContain("- Total recorded challenges: 3");
		expect(result.immutableLedgerSummary).toContain("- Resolved challenges: 3");
		expect(result.immutableLedgerSummary).toContain("- Open challenges: 0");
		for (const stage of ["consensus", "staff-sign-off", "qa-sign-off"] as const) {
			const prompt = prompts.get(stage) ?? "";
			expect(prompt).toContain("## Immutable Challenge Ledger Summary");
			expect(prompt).toContain("- Total recorded challenges: 3");
			expect(prompt).toContain("Do not state a numeric ledger-entry or ledger-challenge total yourself.");
		}
		expect(result.markdown).toContain("## Immutable Challenge Ledger Summary");
	});

	it("rejects a consensus that writes an inconsistent ledger count", async () => {
		const calls: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage }> = [];

		const result = await runAnsteelDiscussion({
			topic: "Reject a hallucinated consensus ledger count",
			runRole: async ({ role, stage }) => {
				calls.push({ role, stage });
				return stage === "consensus"
					? "[L1] Consensus\nAll 2 ledger entries are resolved."
					: responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("invalid-ledger-summary");
		expect(result.consensus).toBeUndefined();
		expect(result.markdown).toContain("- Total recorded challenges: 3");
		expect(calls.map(({ role, stage }) => `${role}:${stage}`)).not.toContain("staff-engineer:staff-sign-off");
	});

	it("rejects a final sign-off that writes a ledger count instead of citing the immutable summary", async () => {
		const calls: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage }> = [];

		const result = await runAnsteelDiscussion({
			topic: "Reject a hallucinated final sign-off ledger count",
			runRole: async ({ role, stage }) => {
				calls.push({ role, stage });
				return stage === "staff-sign-off"
					? "All 2 ledger challenges are resolved.\nVERDICT: APPROVE"
					: responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("final-sign-off-rejected");
		expect(result.consensus).toBe("[L1] Immutable consensus");
		expect(result.markdown).toContain("- Total recorded challenges: 3");
		expect(calls.map(({ role, stage }) => `${role}:${stage}`)).not.toContain("qa-engineer:qa-sign-off");
	});

	it("requires Staff and QA final sign-off on the immutable Tech Lead consensus", async () => {
		const calls: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage; prompt: string }> = [];

		const result = await runAnsteelDiscussion({
			topic: "Review final governance sign-off",
			runRole: async ({ role, stage, prompt }) => {
				calls.push({ role, stage, prompt });
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("approved");
		expect(result.consensus).toBe("[L1] Immutable consensus");
		expect(calls.map(({ role, stage }) => `${role}:${stage}`)).toEqual(
			MUTUAL_REVIEW_STAGE_ORDER.map(({ role, stage }) => `${role}:${stage}`),
		);
		for (const stage of ["staff-sign-off", "qa-sign-off"] as const) {
			const prompt = calls.find((call) => call.stage === stage)?.prompt ?? "";
			expect(prompt).toContain("[L1] Immutable consensus");
			expect(prompt).toContain("immutable");
		}
	});

	it.each([
		["Staff Engineer", "staff-engineer", "staff-sign-off", "VERDICT: APPROVE "],
		["QA Engineer", "qa-engineer", "qa-sign-off", "VERDICT: APPROVE "],
	] as const)(
		"rejects a non-exact final %s sign-off while preserving the consensus",
		async (_name, rejectedRole, rejectedStage, rejectedResponse) => {
			const calls: Array<{ role: AnsteelRole; stage: string }> = [];

			const result = await runAnsteelDiscussion({
				topic: "Review strict final governance sign-off",
				runRole: async ({ role, stage }) => {
					calls.push({ role, stage });
					if (role === rejectedRole && stage === rejectedStage) return rejectedResponse;
					return responseForMutualReviewStage(stage);
				},
			});

			expect(result.verdict).toBe("rejected");
			expect(result.consensus).toBe("[L1] Immutable consensus");
			expect(result.markdown).toContain("## Tech Lead Consensus\n\n[L1] Immutable consensus");
			expect(calls.at(-1)).toEqual({ role: rejectedRole, stage: rejectedStage });
		},
	);

	it("sends every role explicit L2-L4 confidence discipline", async () => {
		const prompts = new Map<AnsteelRole, string[]>();

		const result = await runAnsteelDiscussion({
			topic: "Review confidence discipline",
			runRole: async ({ role, stage, prompt }) => {
				const rolePrompts = prompts.get(role) ?? [];
				rolePrompts.push(prompt);
				prompts.set(role, rolePrompts);
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("approved");
		for (const role of ["tech-lead", "staff-engineer", "qa-engineer"] as const) {
			const prompt = prompts.get(role)?.[0] ?? "";
			expect(prompt).toContain("L1 requires concrete evidence.");
			expect(prompt).toContain("L2 requires a stated technical basis.");
			expect(prompt).toContain("L3 requires a concrete verification method.");
			expect(prompt).toContain("L4 requires an explicit statement of what is unknown and no conclusion.");
		}
	});

	it.each([
		["a lower-case marker", "verdict: approve"],
		["a split-line marker", "VERDICT:\nAPPROVE"],
		["a missing verdict marker", "[L1] QA completed its review but omitted the required decision"],
		["a marker with trailing whitespace", "VERDICT: APPROVE "],
		["duplicate approval markers", "VERDICT: APPROVE\nVERDICT: APPROVE"],
		["contradictory markers", "VERDICT: APPROVE\nVERDICT: REJECT"],
		["a bullet-list contradiction", "VERDICT: APPROVE\n- VERDICT: REJECT"],
		["a Markdown-heading contradiction", "VERDICT: APPROVE\n## VERDICT: REJECT"],
		["an embedded contradictory verdict", "VERDICT: APPROVE\nThe audit says VERDICT: REJECT"],
		["a pending marker after approval", "VERDICT: APPROVE\nVERDICT PENDING"],
		["an isolated pending marker", "VERDICT PENDING"],
	])("rejects %s in QA verification without running consensus", async (_description, qaVerdict) => {
		const calls: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage }> = [];

		const result = await runAnsteelDiscussion({
			topic: "Review the QA gate",
			runRole: async ({ role, stage }) => {
				calls.push({ role, stage });
				return stage === "qa-verification" ? qaVerdict : responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(result.terminationReason).toBe("invalid-verdict");
		expect(calls.map(({ role, stage }) => `${role}:${stage}`)).not.toContain("tech-lead:consensus");
	});

	it.each([
		["tech-lead", "architecture"],
		["staff-engineer", "staff-critique"],
		["qa-engineer", "qa-critique"],
		["tech-lead", "architecture-revision"],
		["staff-engineer", "staff-verification"],
		["qa-engineer", "qa-verification"],
		["tech-lead", "consensus"],
		["staff-engineer", "staff-sign-off"],
		["qa-engineer", "qa-sign-off"],
	] as const)(
		"rejects a whitespace-only %s / %s response without running later stages",
		async (blankRole, blankStage) => {
			const stageOrder = MUTUAL_REVIEW_STAGE_ORDER;
			const rawWhitespace = " \t \r\n";
			const calls: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage }> = [];
			const blankIndex = stageOrder.findIndex(({ role, stage }) => role === blankRole && stage === blankStage);

			const result = await runAnsteelDiscussion({
				topic: "Review empty role output",
				runRole: async ({ role, stage }) => {
					calls.push({ role, stage });
					if (role === blankRole && stage === blankStage) return rawWhitespace;
					return responseForMutualReviewStage(stage);
				},
			});

			expect(result.verdict).toBe("rejected");
			expect(result.consensus).toBe(
				blankIndex > stageOrder.findIndex(({ stage }) => stage === "consensus")
					? "[L1] Immutable consensus"
					: undefined,
			);
			expect(calls).toEqual(stageOrder.slice(0, blankIndex + 1));
			expect(result.transcript.at(-1)?.response).toBe(rawWhitespace);
			expect(result.markdown).toContain(
				`${blankRole} / ${blankStage} returned an empty or whitespace-only response`,
			);
			expect(result.markdown).toContain(rawWhitespace);
		},
	);

	it("archives a failed stage without inventing a role response or running later stages", async () => {
		const calls: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage }> = [];

		const result = await runAnsteelDiscussion({
			topic: "Review a failed provider call",
			runRole: async ({ role, stage }) => {
				calls.push({ role, stage });
				if (role === "staff-engineer" && stage === "staff-critique") {
					throw new Error("provider connection closed");
				}
				return completeWorkCard("[L1] Architecture evidence ");
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(result.failure).toEqual({
			role: "staff-engineer",
			stage: "staff-critique",
			reason: "provider connection closed",
		});
		expect(result.transcript).toEqual([
			expect.objectContaining({
				role: "tech-lead",
				stage: "architecture",
				response: completeWorkCard("[L1] Architecture evidence "),
			}),
		]);
		expect(calls).toEqual([
			{ role: "tech-lead", stage: "architecture" },
			{ role: "staff-engineer", stage: "staff-critique" },
		]);
		expect(result.markdown).toContain("## Stage Failure");
		expect(result.markdown).toContain("- Failed role: staff-engineer");
		expect(result.markdown).toContain("- Failed stage: staff-critique");
		expect(result.markdown).toContain("- Reason: provider connection closed");
	});

	it("archives a project-session prompt failure and disposes every created session", async () => {
		type TestModel = { provider: string; id: string };
		const prompts: Array<{ role: AnsteelRole; prompt: string }> = [];
		const created: AnsteelRole[] = [];
		const disposed: AnsteelRole[] = [];

		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review a failed role session",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => {
				created.push(role);
				return {
					prompt: async (prompt) => {
						prompts.push({ role, prompt });
						if (role === "staff-engineer") throw new Error("role session timed out");
						return completeWorkCard("[L1] Architecture evidence ");
					},
					dispose: () => {
						disposed.push(role);
					},
				};
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(result.failure).toEqual({
			role: "staff-engineer",
			stage: "staff-critique",
			reason: "role session timed out",
		});
		expect(result.transcript).toEqual([
			expect.objectContaining({
				role: "tech-lead",
				stage: "architecture",
				response: completeWorkCard("[L1] Architecture evidence "),
			}),
		]);
		expect(prompts.map(({ role }) => role)).toEqual(["tech-lead", "staff-engineer"]);
		expect(prompts.some(({ prompt }) => prompt.includes("Current stage: consensus."))).toBe(false);
		expect(created).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
		expect(disposed).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
	});

	it("returns an auditable rejection when a project-stage prompt exceeds its timeout", async () => {
		type TestModel = { provider: string; id: string };
		const aborted: AnsteelRole[] = [];
		const disposed: AnsteelRole[] = [];
		let rejectStaffPrompt: ((reason?: unknown) => void) | undefined;

		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review a hung role session",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
				stageTimeoutMs: 20,
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => {
				const session = {
					prompt: async () => {
						if (role === "staff-engineer") {
							return await new Promise<string>((_resolve, reject) => {
								rejectStaffPrompt = reject;
							});
						}
						return completeWorkCard("[L1] Architecture evidence");
					},
					abort: () => {
						aborted.push(role);
						if (role === "staff-engineer") rejectStaffPrompt?.(new Error("session aborted after timeout"));
					},
					dispose: () => {
						disposed.push(role);
					},
					getLastStageAudit: () => ({
						events: [
							{ type: "stage-prompt-start" as const, elapsedMs: 0 },
							{ type: "tool-execution-start" as const, elapsedMs: 1, toolName: "find" },
						],
					}),
				};
				return session;
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(result.terminationReason).toBe("stage-timeout");
		expect(result.failure).toEqual({
			role: "staff-engineer",
			stage: "staff-critique",
			reason: "Stage exceeded the configured timeout of 20ms",
			timeoutMs: 20,
		});
		expect(aborted).toEqual(["staff-engineer"]);
		expect(disposed).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
		expect(result.markdown).toContain("- Termination reason: stage-timeout");
		expect(result.markdown).toContain("- Timeout: 20ms");
		expect(result.markdown).toContain("## Stage Audit Trail");
		expect(result.markdown).toContain("tool-execution-start: find");
		expect((result as typeof result & { stageAudits?: unknown }).stageAudits).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "staff-engineer",
					stage: "staff-critique",
					events: expect.arrayContaining([expect.objectContaining({ toolName: "find" })]),
				}),
			]),
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
	}, 1_000);

	it("archives timeout and abort events that arrive asynchronously", async () => {
		type TestModel = { provider: string; id: string };
		const staffAgentEvents = createAgentEventEmitter();
		const staffAssistantMessages = createAssistantMessageEmitter();
		let rejectStaffPrompt: ((reason?: unknown) => void) | undefined;

		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Archive timeout abort audit",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
				stageTimeoutMs: 20,
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => {
				if (role !== "staff-engineer") {
					return { prompt: async () => completeWorkCard("[L1] Architecture evidence"), dispose: () => {} };
				}

				return createAnsteelRawTurnSession({
					prompt: async () =>
						await new Promise<void>((_resolve, reject) => {
							rejectStaffPrompt = reject;
						}),
					subscribeToAssistantMessageEnd: staffAssistantMessages.subscribe,
					subscribeToAgentEvent: staffAgentEvents.subscribe,
					abort: async () => {
						await Promise.resolve();
						staffAgentEvents.emit({
							type: "tool_execution_end",
							toolCallId: "abort-read",
							toolName: "read",
							isError: true,
						});
						staffAssistantMessages.emit({
							role: "assistant",
							content: [],
							stopReason: "error",
							errorMessage: "aborted after timeout",
						});
						rejectStaffPrompt?.(new Error("session aborted after timeout"));
					},
					dispose: () => {},
				});
			},
		});

		const audit = result.stageAudits.find(
			(candidate) => candidate.role === "staff-engineer" && candidate.stage === "staff-critique",
		);
		expect(audit?.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "stage-timeout" }),
				expect.objectContaining({ type: "tool-execution-end", toolName: "read", isError: true }),
				expect.objectContaining({ type: "assistant-message-end", stopReason: "error" }),
			]),
		);
	});

	it("does not wait indefinitely for a timed-out role abort", async () => {
		type TestModel = { provider: string; id: string };
		let failTimeout: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await Promise.race([
				runAnsteelProjectReview<TestModel>({
					topic: "Bound a hung timeout abort",
					cwd: process.cwd(),
					config: {
						roles: {
							"tech-lead": { model: "tech/lead", tools: ["read"] },
							"staff-engineer": { model: "staff/engineer", tools: ["read"] },
							"qa-engineer": { model: "qa/engineer", tools: ["read"] },
						},
						reportDirectory: "unused",
						stageTimeoutMs: 20,
					},
					resolveModel: (provider, id) => ({ provider, id }),
					createRoleSession: async ({ role }) => ({
						prompt: async () => {
							if (role === "staff-engineer") return await new Promise<string>(() => {});
							return completeWorkCard("[L1] Architecture evidence");
						},
						abort: () => {
							if (role === "staff-engineer") return new Promise<void>(() => {});
						},
						dispose: () => {},
					}),
				}),
				new Promise<never>((_resolve, reject) => {
					failTimeout = setTimeout(() => reject(new Error("Timed-out role abort was not bounded")), 1_000);
				}),
			]);

			expect(result.failure).toEqual({
				role: "staff-engineer",
				stage: "staff-critique",
				reason: "Stage exceeded the configured timeout of 20ms",
				timeoutMs: 20,
			});
		} finally {
			if (failTimeout) clearTimeout(failTimeout);
		}
	});

	it("preserves a rejected prompt failure when session cleanup also fails", async () => {
		type TestModel = { provider: string; id: string };
		const disposed: AnsteelRole[] = [];

		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review cleanup after a failed role prompt",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => ({
				prompt: async () => {
					if (role === "staff-engineer") throw new Error("role session timed out");
					return completeWorkCard("[L1] Architecture evidence");
				},
				dispose: () => {
					disposed.push(role);
					if (role === "tech-lead") {
						throw new Error("tech-lead cleanup failed Authorization: Bearer sk-unit-test-cleanup-secret");
					}
					if (role === "staff-engineer") throw new Error("staff-engineer cleanup failed");
				},
			}),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.failure).toEqual({
			role: "staff-engineer",
			stage: "staff-critique",
			reason: "role session timed out",
		});
		expect(result.transcript).toEqual([
			expect.objectContaining({
				role: "tech-lead",
				stage: "architecture",
				response: completeWorkCard("[L1] Architecture evidence"),
			}),
		]);
		expect(disposed).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
		expect(result.cleanupFailures).toEqual([
			{ role: "tech-lead", reason: "tech-lead cleanup failed Authorization: Bearer [REDACTED]" },
			{ role: "staff-engineer", reason: "staff-engineer cleanup failed" },
		]);
		expect(result.markdown).toContain("## Session Cleanup Failures");
		expect(result.markdown).toContain("- tech-lead: tech-lead cleanup failed Authorization: Bearer [REDACTED]");
		expect(result.markdown).not.toContain("sk-unit-test-cleanup-secret");
		expect(result.markdown).toContain("- staff-engineer: staff-engineer cleanup failed");
	});

	it("keeps a rejected review and completes cleanup when cleanup error formatting throws", async () => {
		type TestModel = { provider: string; id: string };
		const disposed: AnsteelRole[] = [];
		const throwingCoercion = {
			toString: () => {
				throw new Error("cleanup coercion failed");
			},
		};
		const throwingMessageGetter = new Error("hidden cleanup failure");
		Object.defineProperty(throwingMessageGetter, "message", {
			configurable: true,
			get: () => {
				throw new Error("cleanup message getter failed");
			},
		});

		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review cleanup error boundaries",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => ({
				prompt: async () => {
					if (role === "staff-engineer") throw new Error("provider request failed");
					return completeWorkCard("[L1] Architecture evidence");
				},
				dispose: () => {
					disposed.push(role);
					if (role === "tech-lead") throw throwingCoercion;
					if (role === "staff-engineer") throw throwingMessageGetter;
				},
			}),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.failure).toEqual({
			role: "staff-engineer",
			stage: "staff-critique",
			reason: "provider request failed",
		});
		expect(disposed).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
		expect(result.cleanupFailures).toEqual([
			{ role: "tech-lead", reason: "Unknown role failure" },
			{ role: "staff-engineer", reason: "Unknown role failure" },
		]);
		expect(result.markdown).toContain("## Session Cleanup Failures");
		expect(result.markdown).toContain("- tech-lead: Unknown role failure");
		expect(result.markdown).toContain("- staff-engineer: Unknown role failure");
	});

	it("preserves a role-session setup failure over cleanup failures", async () => {
		type TestModel = { provider: string; id: string };
		const disposed: AnsteelRole[] = [];

		await expect(
			runAnsteelProjectReview<TestModel>({
				topic: "Review a role-session setup failure",
				cwd: process.cwd(),
				config: {
					roles: {
						"tech-lead": { model: "tech/lead", tools: ["read"] },
						"staff-engineer": { model: "staff/engineer", tools: ["read"] },
						"qa-engineer": { model: "qa/engineer", tools: ["read"] },
					},
					reportDirectory: "unused",
				},
				resolveModel: (provider, id) => ({ provider, id }),
				createRoleSession: async ({ role }) => {
					if (role === "staff-engineer") throw new Error("staff-engineer setup failed");
					return {
						prompt: async () => "[L1] Scope evidence",
						dispose: () => {
							disposed.push(role);
							throw new Error("tech-lead cleanup failed");
						},
					};
				},
			}),
		).rejects.toThrow("staff-engineer setup failed");

		expect(disposed).toEqual(["tech-lead"]);
	});

	it("loads independent role models with evidence tools for every role", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
		temporaryDirectories.push(cwd);
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(
			join(cwd, ".pi", "ansteel.json"),
			JSON.stringify({
				roles: {
					"tech-lead": { model: "anthropic/claude-sonnet" },
					"staff-engineer": { model: "openai/gpt-5", thinkingLevel: "high" },
					"qa-engineer": { model: "deepseek/deepseek-chat" },
				},
			}),
		);

		const config = loadAnsteelConfig(cwd);

		expect(config.roles["tech-lead"].model).toBe("anthropic/claude-sonnet");
		expect(config.roles["staff-engineer"].model).toBe("openai/gpt-5");
		expect(config.roles["staff-engineer"].thinkingLevel).toBe("high");
		expect(config.roles["qa-engineer"].model).toBe("deepseek/deepseek-chat");
		expect(config.roles["qa-engineer"].tools).toEqual(["read", "grep", "find", "ls", "bash"]);
		expect(config.roles["qa-engineer"].teamTools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write"]);
		expect(config.stageTimeoutMs).toBe(120_000);
		expect(config.maxToolCallsPerStage).toBe(4);
	});

	it("loads role-local memory and skill paths", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
		temporaryDirectories.push(cwd);
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(
			join(cwd, ".pi", "ansteel.json"),
			JSON.stringify({
				roles: {
					"tech-lead": { model: "anthropic/claude-sonnet" },
					"staff-engineer": {
						model: "openai/gpt-5",
						memoryFile: ".pi/ansteel-memory/staff-engineer.md",
						skillPaths: [".pi/ansteel-skills/staff-engineer"],
					},
					"qa-engineer": { model: "deepseek/deepseek-chat" },
				},
			}),
		);

		const config = loadAnsteelConfig(cwd);

		expect(config.roles["staff-engineer"].memoryFile).toBe(join(cwd, ".pi", "ansteel-memory", "staff-engineer.md"));
		expect(config.roles["staff-engineer"].skillPaths).toEqual([join(cwd, ".pi", "ansteel-skills", "staff-engineer")]);
	});

	it("rejects role-local resources outside the reviewed project", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
		temporaryDirectories.push(cwd);
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(
			join(cwd, ".pi", "ansteel.json"),
			JSON.stringify({
				roles: {
					"tech-lead": { model: "anthropic/claude-sonnet" },
					"staff-engineer": { model: "openai/gpt-5", memoryFile: "../other-project/memory.md" },
					"qa-engineer": { model: "deepseek/deepseek-chat" },
				},
			}),
		);

		expect(() => loadAnsteelConfig(cwd)).toThrow("Ansteel role resources must stay inside the reviewed project");
	});

	it("rejects a stage timeout that cannot enforce a bounded review", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
		temporaryDirectories.push(cwd);
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(
			join(cwd, ".pi", "ansteel.json"),
			JSON.stringify({
				stageTimeoutMs: 0,
				roles: {
					"tech-lead": { model: "anthropic/claude-sonnet" },
					"staff-engineer": { model: "openai/gpt-5" },
					"qa-engineer": { model: "deepseek/deepseek-chat" },
				},
			}),
		);

		expect(() => loadAnsteelConfig(cwd)).toThrow("Ansteel stageTimeoutMs must be an integer between 1");
	});

	it("rejects an Ansteel tool budget that cannot bound a role stage", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
		temporaryDirectories.push(cwd);
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(
			join(cwd, ".pi", "ansteel.json"),
			JSON.stringify({
				maxToolCallsPerStage: 0,
				roles: {
					"tech-lead": { model: "anthropic/claude-sonnet" },
					"staff-engineer": { model: "openai/gpt-5" },
					"qa-engineer": { model: "deepseek/deepseek-chat" },
				},
			}),
		);

		expect(() => loadAnsteelConfig(cwd)).toThrow("Ansteel maxToolCallsPerStage must be an integer between 1");
	});

	it("requires a project-local Ansteel configuration", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
		temporaryDirectories.push(cwd);

		expect(() => loadAnsteelConfig(cwd)).toThrow(`Ansteel governance requires ${join(cwd, ".pi", "ansteel.json")}`);
	});

	it("rejects a configured report directory outside the reviewed project", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
		temporaryDirectories.push(cwd);
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(
			join(cwd, ".pi", "ansteel.json"),
			JSON.stringify({
				reportDirectory: "../outside-ansteel-reports",
				roles: {
					"tech-lead": { model: "anthropic/claude-sonnet" },
					"staff-engineer": { model: "openai/gpt-5" },
					"qa-engineer": { model: "deepseek/deepseek-chat" },
				},
			}),
		);

		expect(() => loadAnsteelConfig(cwd)).toThrow("Ansteel reportDirectory must stay inside the reviewed project");
	});

	it("requires an explicit model for every governance role before creating sessions", async () => {
		type TestModel = { provider: string; id: string };
		let createdSessionCount = 0;

		const review = runAnsteelProjectReview<TestModel>({
			topic: "Review mandatory role models",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "claude/sonnet", tools: ["read"] },
					"staff-engineer": { tools: ["read"] },
					"qa-engineer": { model: "deepseek/chat", tools: ["read"] },
				},
				reportDirectory: "unused",
			} as unknown as AnsteelConfig,
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async () => {
				createdSessionCount++;
				return {
					prompt: async () => "[L2] Unexpected role response",
					dispose: () => {},
				};
			},
		});

		await expect(review).rejects.toMatchObject({
			name: "AnsteelGovernanceSetupError",
			phase: "configuration",
			role: "staff-engineer",
		});
		await expect(review).rejects.toThrow("Ansteel role staff-engineer requires an explicit provider/model");

		expect(createdSessionCount).toBe(0);
	});

	it("permits duplicate role models only when single-model mode is explicit", async () => {
		type TestModel = { provider: string; id: string };
		const createdRoles: AnsteelRole[] = [];

		await runAnsteelProjectReview<TestModel>({
			topic: "Review explicit single-model mode",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "deepseek/deepseek-v4-pro", tools: ["read"] },
					"staff-engineer": { model: "deepseek/deepseek-v4-pro", tools: ["read"] },
					"qa-engineer": { model: "deepseek/deepseek-v4-pro", tools: ["read"] },
				},
				reportDirectory: "unused",
				allowSingleModel: true,
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => {
				createdRoles.push(role);
				return {
					prompt: async (prompt) => responseForMutualReviewStage(getStageFromPrompt(prompt)),
					dispose: () => {},
				};
			},
		});

		expect(createdRoles).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
	});

	it("rejects duplicate role models before creating governance sessions", async () => {
		type TestModel = { provider: string; id: string };
		let createdSessionCount = 0;

		await expect(
			runAnsteelProjectReview<TestModel>({
				topic: "Review duplicate role models",
				cwd: process.cwd(),
				config: {
					roles: {
						"tech-lead": { model: "shared/model", tools: ["read"] },
						"staff-engineer": { model: "shared/model", tools: ["read"] },
						"qa-engineer": { model: "qa/engineer", tools: ["read"] },
					},
					reportDirectory: "unused",
				},
				resolveModel: (provider, id) => ({ provider, id }),
				createRoleSession: async () => {
					createdSessionCount++;
					return {
						prompt: async () => "[L2] Unexpected role response",
						dispose: () => {},
					};
				},
			}),
		).rejects.toThrow(
			"Ansteel governance requires distinct role models: staff-engineer duplicates tech-lead (shared/model)",
		);

		expect(createdSessionCount).toBe(0);
	});

	it("permits supplied QA bash configuration for evidence verification", async () => {
		type TestModel = { provider: string; id: string };
		let createdSessionCount = 0;
		const sessionSkillPaths: Array<readonly string[]> = [];

		await runAnsteelProjectReview<TestModel>({
			topic: "Review supplied configuration validation",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read", "bash"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ skillPaths }) => {
				createdSessionCount++;
				sessionSkillPaths.push(skillPaths);
				return {
					prompt: async (prompt) => responseForMutualReviewStage(getStageFromPrompt(prompt)),
					dispose: () => {},
				};
			},
		});

		expect(createdSessionCount).toBe(3);
		expect(sessionSkillPaths).toEqual([[], [], []]);
	});

	it("rejects an unsupported role thinking level before creating any role session", async () => {
		type TestModel = { provider: string; id: string };
		let createdSessionCount = 0;

		await expect(
			runAnsteelProjectReview<TestModel>({
				topic: "Review supplied thinking-level validation",
				cwd: process.cwd(),
				config: {
					roles: {
						"tech-lead": { model: "tech/lead", tools: ["read"] },
						"staff-engineer": { model: "staff/engineer", thinkingLevel: "unsupported", tools: ["read"] },
						"qa-engineer": { model: "qa/engineer", tools: ["read"] },
					},
					reportDirectory: "unused",
				} as unknown as AnsteelConfig,
				resolveModel: (provider, id) => ({ provider, id }),
				createRoleSession: async () => {
					createdSessionCount++;
					return {
						prompt: async () => "VERDICT: APPROVE",
						dispose: () => {},
					};
				},
			}),
		).rejects.toThrow("Ansteel role staff-engineer thinkingLevel must be one of");

		expect(createdSessionCount).toBe(0);
	});

	it("creates isolated role sessions with the configured models", async () => {
		type TestModel = { provider: string; id: string };
		const calls: Array<{
			role: AnsteelRole;
			model: TestModel;
			thinkingLevel?: string;
			memoryFile?: string;
			skillPaths: readonly string[];
			tools: readonly string[];
		}> = [];
		const disposed: AnsteelRole[] = [];
		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review the parser",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "claude/sonnet", tools: ["read", "bash"] },
					"staff-engineer": {
						model: "openai/gpt-5",
						thinkingLevel: "high",
						memoryFile: ".pi/ansteel-memory/staff.md",
						skillPaths: [".pi/ansteel-skills/staff"],
						tools: ["read", "grep"],
					},
					"qa-engineer": { model: "deepseek/chat", tools: ["read", "grep", "find", "ls"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role, model, thinkingLevel, memoryFile, skillPaths, tools }) => {
				calls.push({ role, model, thinkingLevel, memoryFile, skillPaths, tools });
				return {
					prompt: async (prompt) => responseForMutualReviewStage(getStageFromPrompt(prompt)),
					dispose: () => {
						disposed.push(role);
					},
				};
			},
		});

		expect(result.verdict).toBe("approved");
		expect(result.roleModels["tech-lead"]).toEqual({ provider: "claude", id: "sonnet" });
		expect(result.roleModels["staff-engineer"]).toEqual({ provider: "openai", id: "gpt-5" });
		expect(calls.find(({ role }) => role === "staff-engineer")?.thinkingLevel).toBe("high");
		expect(calls.find(({ role }) => role === "staff-engineer")?.memoryFile).toBe(
			join(process.cwd(), ".pi", "ansteel-memory", "staff.md"),
		);
		expect(calls.find(({ role }) => role === "staff-engineer")?.skillPaths).toEqual([
			join(process.cwd(), ".pi", "ansteel-skills", "staff"),
		]);
		expect(calls.map(({ role }) => role)).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
		expect(disposed).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
	});

	it("gives every project-review role the same bounded evidence package without historical reports", async () => {
		type TestModel = { provider: string; id: string };
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-evidence-"));
		temporaryDirectories.push(cwd);
		mkdirSync(join(cwd, "src"));
		mkdirSync(join(cwd, "test"));
		mkdirSync(join(cwd, ".pi", "ansteel-reports"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "ansteel-team"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "ansteel-memory"), { recursive: true });
		writeFileSync(join(cwd, "src", "solver.ts"), "export const answer = 42;\n");
		writeFileSync(join(cwd, "test", "solver.test.ts"), "expect(answer).toBe(42);\n");
		writeFileSync(join(cwd, ".pi", "ansteel-reports", "stale.md"), "historical model output");
		writeFileSync(join(cwd, ".pi", "ansteel-team", "events.jsonl"), "role session artifact");
		writeFileSync(join(cwd, ".pi", "ansteel-memory", "qa.md"), "QA private role memory");
		const evidencePackage = createAnsteelEvidencePackage(cwd);
		const prompts: Array<{ role: AnsteelRole; prompt: string }> = [];

		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review shared project evidence",
			cwd,
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => ({
				prompt: async (prompt) => {
					prompts.push({ role, prompt });
					return responseForMutualReviewStage(getStageFromPrompt(prompt));
				},
				dispose: () => {},
			}),
		});

		expect(result.verdict).toBe("approved");
		expect(evidencePackage).toContain("src/solver.ts");
		expect(evidencePackage).toContain("sha256=");
		expect(evidencePackage).toContain("1 | export const answer = 42;");
		expect(evidencePackage).not.toContain("stale.md");
		expect(evidencePackage).not.toContain("historical model output");
		expect(evidencePackage).not.toContain("role session artifact");
		expect(evidencePackage).not.toContain("QA private role memory");
		for (const role of ANSTEEL_ROLES) {
			const rolePrompts = prompts.filter((entry) => entry.role === role);
			expect(rolePrompts.length).toBeGreaterThan(0);
			for (const { prompt } of rolePrompts) expect(prompt).toContain(evidencePackage);
		}
	});

	it("preserves a trailing-space QA verdict from a role session and rejects it", async () => {
		type TestModel = { provider: string; id: string };
		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review the role-session QA gate",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async () => {
				return {
					prompt: async (prompt) =>
						responseForMutualReviewStage(getStageFromPrompt(prompt), { "qa-verification": "VERDICT: APPROVE " }),
					dispose: () => {},
				};
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(result.transcript.at(-1)?.response).toBe("VERDICT: APPROVE ");
		expect(result.markdown).toContain("VERDICT: APPROVE \n");
	});

	it("preserves a trailing-space rejected QA verdict when session cleanup fails", async () => {
		type TestModel = { provider: string; id: string };
		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review cleanup report integrity",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => ({
				prompt: async (prompt) =>
					responseForMutualReviewStage(getStageFromPrompt(prompt), { "qa-verification": "VERDICT: APPROVE " }),
				dispose: () => {
					if (role === "qa-engineer") throw new Error("QA cleanup failed");
				},
			}),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(result.transcript.at(-1)?.response).toBe("VERDICT: APPROVE ");
		expect(result.cleanupFailures).toEqual([{ role: "qa-engineer", reason: "QA cleanup failed" }]);
		expect(result.markdown).toContain("VERDICT: APPROVE \n\n## Session Cleanup Failures");
	});

	it("returns an auditable rejection for a whitespace-only QA session response", async () => {
		type TestModel = { provider: string; id: string };
		const calls: Array<{ role: AnsteelRole; prompt: string }> = [];
		const disposed: AnsteelRole[] = [];
		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review the whitespace-only QA response",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => {
				return {
					prompt: async (prompt) => {
						calls.push({ role, prompt });
						const stage = getStageFromPrompt(prompt);
						return stage === "qa-verification" ? " \t " : responseForMutualReviewStage(stage);
					},
					dispose: () => {
						disposed.push(role);
					},
				};
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(result.transcript.at(-1)?.response).toBe(" \t ");
		expect(result.markdown).toContain("qa-engineer / qa-verification returned an empty or whitespace-only response");
		expect(calls).toHaveLength(12);
		expect(calls.some(({ prompt }) => prompt.includes("Current stage: consensus."))).toBe(false);
		expect(disposed).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
	});

	it("allows an exact QA approval marker with a Verdict rationale line", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review the verdict parser",
			runRole: async ({ stage }) =>
				responseForMutualReviewStage(stage, {
					"qa-verification":
						"VERDICT: APPROVE\nVerdict rationale: [L1] The required test passed\n[L2] Monitor the follow-up",
					consensus: "[L2] Consensus",
				}),
		});

		expect(result.verdict).toBe("approved");
		expect(result.consensus).toBe("[L2] Consensus");
	});

	it("uses a nonzero CLI outcome for a rejected review", () => {
		expect(getAnsteelReviewExitCode("rejected")).toBe(1);
		expect(getAnsteelReviewExitCode("approved")).toBe(0);
	});

	it("writes an auditable Markdown report below the configured report directory", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
		temporaryDirectories.push(cwd);
		const reportDirectory = join(cwd, ".pi", "ansteel-reports");

		const reportPath = writeAnsteelReport({
			reportDirectory,
			topic: "Review parser safety",
			markdown: "# Review\n\n[L1] Evidence\nRaw transcript trailing space: ",
			now: new Date("2026-07-22T08:15:30.000Z"),
		});

		expect(reportPath.startsWith(reportDirectory)).toBe(true);
		expect(existsSync(reportPath)).toBe(true);
		expect(readFileSync(reportPath, "utf-8")).toBe("# Review\n\n[L1] Evidence\nRaw transcript trailing space: ");
	});

	it("formats a sanitized setup rejection with the configured governance models", () => {
		const markdown = createAnsteelSetupFailureMarkdown({
			topic: "Review setup failure archiving",
			config: {
				roles: {
					"tech-lead": { model: "claude/sonnet", tools: ["read"] },
					"staff-engineer": { model: "openai/gpt-5", tools: ["read"] },
					"qa-engineer": { model: "deepseek/chat", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			error: new AnsteelGovernanceSetupError(
				"Authorization: Bearer top-secret-token; API key: super-secret-key\nwhile resolving the model",
				"model-resolution",
				"staff-engineer",
			),
		});

		expect(markdown).toContain("- Result: REJECTED");
		expect(markdown).toContain("- Failed role: staff-engineer");
		expect(markdown).toContain("- Failed phase: model-resolution");
		expect(markdown).toContain("- tech-lead: claude/sonnet");
		expect(markdown).toContain("- staff-engineer: openai/gpt-5");
		expect(markdown).toContain("Authorization: Bearer [REDACTED]");
		expect(markdown).toContain("API key: [REDACTED]");
		expect(markdown).not.toContain("top-secret-token");
		expect(markdown).not.toContain("super-secret-key");
	});
});
