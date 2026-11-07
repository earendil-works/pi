// Completion gate + watchdog: evidence audit, then LLM review, then targeted re-prompt.
import { execFileSync } from "node:child_process";
import type { Store } from "@earendil-works/pi-orchestra-core";
import type { CheckOutcome } from "./goals.ts";

export interface Gap {
	type: string;
	detail: string;
}

export interface AuditInput {
	taskId: string;
	worktree: string;
	ownsGlobs: string[];
	changedFiles: string[];
	lastEditAt: number;
	hasTestAfterEdit: boolean;
	hasTypecheckAfterEdit: boolean;
	hasScreenshotAfterEdit?: boolean;
	isUI: boolean;
	diffText: string;
}

export function evidenceAudit(input: AuditInput): Gap[] {
	const gaps: Gap[] = [];
	if (!input.hasTestAfterEdit)
		gaps.push({
			type: "no-test-after-edit",
			detail: "no test command ran after your last edit; run the full suite and report the result",
		});
	if (!input.hasTypecheckAfterEdit)
		gaps.push({
			type: "no-typecheck-after-edit",
			detail: "no typecheck ran after your last edit; run the typecheck and report",
		});
	if (input.isUI && !input.hasScreenshotAfterEdit)
		gaps.push({
			type: "no-screenshot-after-edit",
			detail: "for UI work, take a screenshot after the last edit and run baseline diff",
		});
	for (const f of input.changedFiles) {
		const owned = input.ownsGlobs.length === 0 || input.ownsGlobs.some((g) => f.startsWith(g.replace("/**", "")));
		if (!owned) gaps.push({ type: "unowned-file", detail: `touched ${f} outside owns_globs` });
	}
	if (/TODO|FIXME|STUB|XXX/.test(input.diffText))
		gaps.push({ type: "todo-marker", detail: "diff contains TODO/FIXME/STUB markers" });
	try {
		const status = execFileSync("git", ["status", "--porcelain"], {
			cwd: input.worktree,
			encoding: "utf8",
		}).toString();
		if (status.trim().length > 0) {
			const uncommitted = status.split("\n").filter((l) => l.trim().length > 0).length;
			if (uncommitted > 0)
				gaps.push({ type: "uncommitted-changes", detail: `${uncommitted} uncommitted change(s) in worktree` });
		}
	} catch {
		// Not a git worktree in tests; skip.
	}
	return gaps;
}

export function targetedReprompt(gaps: Gap[]): string {
	// Generic "do better" is forbidden: cite specific missing evidence.
	return gaps
		.map((g) => `- ${g.type}: ${g.detail}`)
		.join("\n")
		.split("\n")
		.map((l) => l.trim())
		.join("\n");
}

export interface CompletionGateResult {
	complete: boolean;
	gaps: Gap[];
}

export async function completionGate(input: {
	store: Store;
	taskId: string;
	worktree: string;
	audit: AuditInput;
	checks: CheckOutcome[];
	llmReview?: (spec: string, diff: string, evidence: string) => Promise<string | null>;
	spec: string;
	maxReprompts?: number;
	round?: number;
}): Promise<CompletionGateResult> {
	const gaps = evidenceAudit(input.audit);
	if (gaps.length > 0) return { complete: false, gaps };
	if (!input.checks.every((c) => c.passed)) {
		const failed = input.checks
			.filter((c) => !c.passed)
			.map((c) => c.checkId)
			.join(",");
		return { complete: false, gaps: [{ type: "checks-failed", detail: `failed checks: ${failed}` }] };
	}
	if (input.llmReview) {
		const gapsFromLlm = await input.llmReview(input.spec, input.audit.diffText, JSON.stringify(input.checks));
		if (gapsFromLlm) {
			if (gapsFromLlm.trim().toLowerCase() !== "complete") {
				return { complete: false, gaps: [{ type: "llm-review", detail: gapsFromLlm.slice(0, 2000) }] };
			}
		}
	}
	return { complete: true, gaps: [] };
}
