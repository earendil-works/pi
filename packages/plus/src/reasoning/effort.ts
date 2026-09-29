/**
 * Claude Code-style reasoning effort model for pi, ported from
 * openclaude/src/utils/effort.ts and openclaude/src/utils/thinking.ts
 * (precedence chain, adaptive-vs-budgeted dispatch, ultrathink), with pi-style env vars:
 *   PI_EFFORT_LEVEL                "off" | "auto" | "low" | "medium" | "high" | "max"
 *   PI_ALWAYS_ENABLE_EFFORT        force effort support on any model
 *   PI_MAX_THINKING_TOKENS         >0 thinking budget for "high", 0 disables
 *   PI_DISABLE_THINKING            disable thinking entirely
 *   PI_DISABLE_ADAPTIVE_THINKING   force the budget-based thinking path
 *
 * Per-level thinking budgets need no env var here: pi's built-in `settings.thinkingBudgets`
 * (and hub profiles) flow into the request natively; this wrapper only merges the env
 * escape hatch on top and strips budgets for adaptive models.
 */
import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ThinkingBudgets } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai/compat";

export const EFFORT_LEVELS = ["low", "medium", "high", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * Outcome of resolving the effort to apply, mirroring openclaude's resolveAppliedEffort:
 * - "level": a concrete thinking level to send
 * - "off": thinking disabled; strip reasoning from the request
 * - "clear": no level to impose; strip reasoning so the provider default stands
 */
export type ResolvedEffort =
	| { kind: "level"; level: Exclude<ThinkingLevel, "off"> }
	| { kind: "off" }
	| { kind: "clear" };

const ULTRATHINK_PATTERN = /\bultrathink\b/i;

function isEnvTruthy(value: string | undefined): boolean {
	return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

export function isThinkingDisabled(): boolean {
	return isEnvTruthy(process.env.PI_DISABLE_THINKING);
}

export function isAdaptiveThinkingDisabled(): boolean {
	return isEnvTruthy(process.env.PI_DISABLE_ADAPTIVE_THINKING);
}

/** Force effort support even on models not cataloged as reasoning models. */
export function isAlwaysEnableEffort(): boolean {
	return isEnvTruthy(process.env.PI_ALWAYS_ENABLE_EFFORT);
}

/** Adaptive thinking applies when the model's compat requests it and the env allows it. */
export function shouldUseAdaptiveThinking(model: Model<any>): boolean {
	// Compat flags live on per-api interfaces; probe the shared flag structurally.
	const compat = model.compat as { forceAdaptiveThinking?: boolean } | undefined;
	return !isAdaptiveThinkingDisabled() && !isThinkingDisabled() && compat?.forceAdaptiveThinking === true;
}

/** Map a CC effort level onto a pi thinking level, downgrading like CC (max→xhigh→high). */
export function effortToThinkingLevel(model: Model<any>, effort: EffortLevel): Exclude<ThinkingLevel, "off"> {
	if (effort === "max") {
		const supported = getSupportedThinkingLevels(model);
		if (supported.includes("xhigh")) return "xhigh";
		return "high";
	}
	return effort;
}

/** Clamp a requested level to what the model supports, mapping "off" back to the off result. */
function clampResolvedLevel(model: Model<any>, level: ThinkingLevel): ResolvedEffort {
	const clamped = clampThinkingLevel(model, level);
	if (clamped === "off") return { kind: "off" };
	return { kind: "level", level: clamped };
}

/**
 * Resolve the effort level to apply to a request.
 * Precedence (openclaude resolveAppliedEffort): PI_DISABLE_THINKING > capability guard >
 * env PI_EFFORT_LEVEL ("auto"/"unset" actively clears the session level) > session level >
 * provider default. Capability mismatches clamp instead of erroring.
 */
export function resolveAppliedEffort(model: Model<any>, sessionLevel: ThinkingLevel | undefined): ResolvedEffort {
	if (isThinkingDisabled()) {
		return { kind: "off" };
	}

	// Clamp against the effort-capable view so PI_ALWAYS_ENABLE_EFFORT models aren't
	// downgraded back to off by their cataloged reasoning: false flag.
	const capableModel = ensureEffortCapable(model);
	if (!capableModel.reasoning) {
		// Non-reasoning model: leave the request alone, never error.
		return { kind: "clear" };
	}

	const env = process.env.PI_EFFORT_LEVEL?.toLowerCase();
	if (env !== undefined) {
		if (env === "off") return { kind: "off" };
		if (env === "auto" || env === "unset" || env === "") return { kind: "clear" };
		if ((EFFORT_LEVELS as readonly string[]).includes(env)) {
			return clampResolvedLevel(capableModel, effortToThinkingLevel(capableModel, env as EffortLevel));
		}
		// Unrecognized value: fall through to the session level.
	}

	if (sessionLevel !== undefined) {
		if (sessionLevel === "off") return { kind: "off" };
		return clampResolvedLevel(capableModel, sessionLevel);
	}

	return { kind: "clear" };
}

/**
 * Per-request flag that forces thinking off regardless of the session level, env
 * overrides, adaptive defaults, or the ultrathink keyword. Compaction summarization
 * sets it: the summary's maxTokens cap is small (0.8 × reserveTokens) and reasoning
 * tokens count against it, so a "high" session level can truncate the summary and
 * fail compaction. A Symbol survives the object spreads pi performs on request
 * options, so the flag reaches wrapStreamFn through completeSummarization.
 */
const NO_REASONING = Symbol.for("pi-plus.noReasoning");

/** Attach the no-reasoning flag to a request options object (mutates and returns it). */
export function markNoReasoning<T>(options: T): T {
	(options as Record<symbol, unknown>)[NO_REASONING] = true;
	return options;
}

/** Whether a request options object was flagged to skip reasoning. */
export function hasNoReasoning(options: unknown): boolean {
	return (
		typeof options === "object" && options !== null && (options as Record<symbol, unknown>)[NO_REASONING] === true
	);
}

/** Thinking budgets from PI_MAX_THINKING_TOKENS (>0), or undefined when unset/invalid. */
export function resolveThinkingBudgetsFromEnv(): ThinkingBudgets | undefined {
	const raw = process.env.PI_MAX_THINKING_TOKENS;
	if (!raw) return undefined;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed) || parsed <= 0) return undefined;
	return { high: parsed };
}

/** Clamp budgets so thinking never consumes the whole output window (openclaude: maxTokens - 1). */
export function clampBudgetsToModel(model: Model<any>, budgets: ThinkingBudgets): ThinkingBudgets {
	const cap = Math.max(0, model.maxTokens - 1);
	const out: ThinkingBudgets = {};
	for (const [key, value] of Object.entries(budgets)) {
		if (value !== undefined) out[key as keyof ThinkingBudgets] = Math.min(value, cap);
	}
	return out;
}

/** Default thinking level from env, or undefined to keep the upstream default. */
export function resolveDefaultThinkingLevelFromEnv(): ThinkingLevel | undefined {
	if (isThinkingDisabled()) return "off";
	const raw = process.env.PI_MAX_THINKING_TOKENS;
	if (raw !== undefined) {
		const parsed = Number.parseInt(raw, 10);
		if (!Number.isNaN(parsed)) {
			return parsed > 0 ? "high" : "off";
		}
	}
	return undefined;
}

/** Extract the text of the last user message from a transcript context. */
function lastUserText(context: TranscriptContext): string | undefined {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		return message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
	}
	return undefined;
}

/** CC's ultrathink keyword: the user explicitly asks for maximum reasoning this turn. */
export function detectUltrathink(context: TranscriptContext): boolean {
	const text = lastUserText(context);
	return text !== undefined && ULTRATHINK_PATTERN.test(text);
}

/** Non-reasoning models only receive effort when PI_ALWAYS_ENABLE_EFFORT forces it. */
function ensureEffortCapable(model: Model<any>): Model<any> {
	if (isAlwaysEnableEffort() && !model.reasoning) return { ...model, reasoning: true };
	return model;
}

/**
 * Wrap a StreamFn to apply the CC effort model per request:
 * env PI_EFFORT_LEVEL / PI_DISABLE_THINKING override the session level, session levels are
 * honored and clamped to the model, adaptive models get budgets stripped (they decide their
 * own spend) with a guaranteed reasoning level, PI_MAX_THINKING_TOKENS injects a budget
 * capped at the output window, and the ultrathink keyword forces maximum effort for the turn.
 */
export function wrapStreamFn(streamFn: StreamFn, getSessionLevel: () => ThinkingLevel | undefined): StreamFn {
	return (model, context, options) => {
		const next: SimpleStreamOptions = { ...options };

		// Capped one-shot requests (compaction summaries) opt out of thinking entirely:
		// reasoning tokens burn the same maxTokens budget as the answer itself.
		if (hasNoReasoning(options)) {
			delete next.reasoning;
			delete next.thinkingBudgets;
			return streamFn(model, context, next);
		}

		const capableModel = ensureEffortCapable(model);

		const resolved = resolveAppliedEffort(capableModel, getSessionLevel());
		if (resolved.kind === "level") {
			next.reasoning = resolved.level;
		} else {
			// "off" and "clear" both strip the level: off disables thinking, clear defers
			// to the provider default.
			delete next.reasoning;
		}

		if (resolved.kind !== "off" && shouldUseAdaptiveThinking(capableModel)) {
			// Adaptive models must not receive a budget (openclaude claude.ts: adaptive path
			// sends no budget), and need an explicit level or the provider disables thinking.
			delete next.thinkingBudgets;
			if (next.reasoning === undefined) {
				const fallback = resolveDefaultThinkingLevelFromEnv();
				next.reasoning = fallback !== undefined && fallback !== "off" ? fallback : "high";
			}
		} else {
			const budgets = resolveThinkingBudgetsFromEnv();
			if (budgets) {
				next.thinkingBudgets = { ...next.thinkingBudgets, ...clampBudgetsToModel(capableModel, budgets) };
			}
		}

		if (resolved.kind !== "off" && detectUltrathink(context)) {
			next.reasoning = effortToThinkingLevel(capableModel, "max");
		}

		return streamFn(capableModel, context, next);
	};
}
