// Thinking levels: fixed or dynamic rubric. Live change via RPC set_thinking_level (no restart needed).
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export interface ThinkingInput {
	spec: string;
	ownsGlobs: string[];
	checks: { kind: string }[];
	ambiguous?: boolean;
	novel?: boolean;
}

export function assignThinking(input: ThinkingInput): { level: ThinkingLevel; reason: string } {
	const spec = input.spec.toLowerCase();
	const risky =
		spec.includes("auth") ||
		spec.includes("security") ||
		spec.includes("delete") ||
		spec.includes("migrate") ||
		spec.includes("invoice") ||
		spec.includes("payment");
	const hardWords = ["race", "deadlock", "consensus", "algorithm", "crypto", "migrate", "refactor", "rewrite", "arch"];
	const isHard = risky || hardWords.some((w) => spec.includes(w)) || input.ambiguous === true || input.novel === true;
	const files = input.ownsGlobs.length;
	const checks = input.checks.length;
	if (isHard && (files >= 3 || checks >= 2)) {
		return { level: "xhigh", reason: `hard/risky spec, files=${files} checks=${checks}` };
	}
	if (isHard) {
		return { level: "high", reason: `hard spec, files=${files} checks=${checks}` };
	}
	if (files <= 1 && checks <= 1 && spec.length < 80) {
		return { level: "low", reason: `trivial: files=${files} checks=${checks} spec_len=${spec.length}` };
	}
	return { level: "medium", reason: `standard: files=${files} checks=${checks} spec_len=${spec.length}` };
}

export function raiseThinking(current: ThinkingLevel): ThinkingLevel {
	const idx = THINKING_LEVELS.indexOf(current);
	const next = THINKING_LEVELS[Math.min(THINKING_LEVELS.length - 1, idx + 1)]!;
	return next;
}
