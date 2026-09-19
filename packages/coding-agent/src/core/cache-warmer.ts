import {
	type Api,
	type Context,
	calculateCost,
	type Model,
	type ModelsSimpleStreamOptions,
	type SimpleStreamOptions,
	type Usage,
} from "@earendil-works/pi-ai";
import { getProviderEnvValue } from "@earendil-works/pi-ai/utils/provider-env";
import type { ModelRuntime } from "./model-runtime.ts";
import type { SessionEntry, SessionManager, UsageEntry } from "./session-manager.ts";
import type { CacheWarmingMode } from "./settings-manager.ts";

/** Streaming warming never continues past this long after the real request that started it. */
const MAX_WARMING_AGE_MS = 60 * 60_000;
/** Idle warming uses a shorter horizon because continuation estimates become less reliable with age. */
const MAX_IDLE_WARMING_AGE_MS = 30 * 60_000;
/** A refresh is sent only when it is expected to save at least this many dollars. */
export const CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS = 0.05;
/**
 * Chance that a real request arrives before the cache entry expires while the
 * agent sits idle. Measured from our own usage; per-session estimates were not
 * better than this constant.
 */
export const IDLE_CONTINUATION_PROBABILITY = 0.15;

/** Refresh at 90% of the TTL while preserving at least ten seconds of margin. */
export function getCacheWarmingDelayMs(ttlMs: number): number | undefined {
	if (ttlMs <= 10_000) return undefined;
	return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}

/**
 * Lifetime of the prompt cache entry a request writes, from the model's
 * `promptCache` tier for the retention the request used. Undefined when the
 * model has no lifetime for that tier or caching is off.
 */
export function getPromptCacheTtlMs(model: Model<Api>, options: SimpleStreamOptions | undefined): number | undefined {
	const retention =
		options?.cacheRetention ??
		(getProviderEnvValue("PI_CACHE_RETENTION", options?.env) === "long" ? "long" : "short");
	if (retention === "none") return undefined;
	const seconds = model.promptCache?.[retention];
	return seconds === undefined ? undefined : seconds * 1000;
}

/**
 * Whether replaying the request with a one-token output cap leaves its cache
 * entry untouched. Anthropic's budget-based thinking (Claude models without
 * adaptive thinking) derives `budget_tokens` from `max_tokens`; the replay
 * would get a different budget, which Anthropic keys the message cache on,
 * and the model could still think for thousands of tokens.
 */
export function isReplayable(model: Model<Api>, options: SimpleStreamOptions | undefined): boolean {
	if (!options?.reasoning || model.api !== "anthropic-messages") return true;
	return (model as Model<"anthropic-messages">).compat?.forceAdaptiveThinking === true;
}

/** Prompt size of the most recent real request on the branch, as reported by the provider. */
function lastPromptTokens(entries: SessionEntry[]): number {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "message" && entry.message.role === "assistant") {
			const usage = entry.message.usage;
			return usage.input + usage.cacheRead + usage.cacheWrite;
		}
	}
	return 0;
}

function price(
	model: Model<Api>,
	tokens: Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">>,
): number {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...tokens,
	};
	return calculateCost(model, usage).total;
}

export type CacheWarmingAction = "warm" | "stop";

/** Inputs and outcome of one warm-or-stop decision, as shown by `/session`. */
export interface CacheWarmingDecision {
	/** "streaming" while the agent run that sent the request is still active. */
	phase: "streaming" | "idle";
	/** Price of this refresh: a cache read of the prompt plus one output token. */
	warmCost: number;
	/** Extra price of the next real request if the cache entry is lost. */
	missCost: number;
	/** Price of the refreshes already sent for this entry. */
	spentCost: number;
	/** Estimated chance that a real request arrives before the entry expires. */
	continuationProbability: number;
	/** `continuationProbability * missCost - spentCost - warmCost`. */
	expectedSavings: number;
	/** False when the prompt size or the model's prices are unknown. */
	economicsAvailable: boolean;
	/** Pi's decision: "warm" when `expectedSavings` is at least $0.05. */
	action: CacheWarmingAction;
}

/**
 * Fired before each refresh with pi's decision filled in. Everything else an
 * extension might want (model, idle state, context size) is on the context.
 */
export interface CacheWarmingDecisionEvent
	extends Pick<CacheWarmingDecision, "warmCost" | "missCost" | "spentCost" | "continuationProbability" | "action"> {
	type: "cache_warming_decision";
}

export interface CacheWarmingDecisionEventResult {
	/** Override whether this refresh is sent. "stop" ends warming until the next real request. */
	action?: CacheWarmingAction;
}

export interface CacheWarmingStatus {
	/** "scheduled": a refresh timer is armed; "refreshing": a warm request is in flight. */
	state: "inactive" | "scheduled" | "refreshing";
	/** Why nothing is scheduled. */
	reason?: string;
	nextWarmAt?: number;
	/** The pending decision, or the decision that stopped warming. */
	decision?: CacheWarmingDecision;
	/** True when an extension changed `decision.action`. */
	extensionOverride?: boolean;
}

/** The request whose prompt cache entry should be kept warm, exactly as it was sent. */
export interface CacheWarmRequest {
	model: Model<Api>;
	context: Context;
	options: ModelsSimpleStreamOptions;
}

interface ActiveRun extends CacheWarmRequest {
	/** False once the session's model or messages no longer match the request. */
	isCurrent: () => boolean;
	delayMs: number;
	startedAt: number;
	controller: AbortController;
	phase: "streaming" | "idle";
	spentCost: number;
	nextWarmAt: number;
	/** Set while a refresh that an extension forced is in flight. */
	extensionOverride: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

/**
 * Keeps one prompt cache entry alive by re-sending its request with a
 * one-token output cap before the entry expires. `start` replaces any
 * previous run; warm requests never extend the fixed safety windows.
 */
export class CacheWarmer {
	private run?: ActiveRun;
	private inactive: CacheWarmingStatus;
	private readonly models: Pick<ModelRuntime, "streamSimple">;
	private readonly sessionManager: Pick<SessionManager, "appendUsage" | "getBranch">;
	private readonly getMode: () => CacheWarmingMode;
	/** Lets extensions override `event.action`; failures fall back to pi's decision. */
	private readonly decide: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmingAction>;
	/** Called with the persisted usage entry after each successful refresh. */
	onWarmed?: (entry: UsageEntry) => void;

	constructor(
		models: Pick<ModelRuntime, "streamSimple">,
		sessionManager: Pick<SessionManager, "appendUsage" | "getBranch">,
		getMode: () => CacheWarmingMode,
		decide: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmingAction> = async (event) => event.action,
		initialInactiveReason = "waiting for first request",
	) {
		this.models = models;
		this.sessionManager = sessionManager;
		this.getMode = getMode;
		this.decide = decide;
		this.inactive = { state: "inactive", reason: initialInactiveReason };
	}

	get status(): CacheWarmingStatus {
		if (this.getMode() === "off") return { state: "inactive", reason: "cache warming disabled" };
		const run = this.run;
		if (!run) return this.inactive;
		if (!run.isCurrent()) return { state: "inactive", reason: "conversation context changed" };
		const decision = this.evaluate(run);
		const refreshing = run.timer === undefined;
		if (!decision.economicsAvailable && !refreshing) {
			return { state: "inactive", reason: "cache economics unavailable" };
		}
		return {
			state: refreshing ? "refreshing" : "scheduled",
			nextWarmAt: run.nextWarmAt,
			decision,
			extensionOverride: run.extensionOverride,
		};
	}

	/** Keep the prompt cache entry written by `request` warm while `isCurrent` holds. */
	start(
		request: CacheWarmRequest,
		isCurrent: () => boolean,
		restored?: { lastActivityAt: number; startedAt: number; spentCost: number },
	): void {
		this.clearRun();
		const mode = this.getMode();
		if (mode === "off") {
			this.stop("cache warming disabled");
			return;
		}
		if (!isReplayable(request.model, request.options)) {
			this.stop("request cannot be replayed safely");
			return;
		}
		const ttlMs = getPromptCacheTtlMs(request.model, request.options);
		if (ttlMs === undefined) {
			this.stop(
				request.options.cacheRetention === "none"
					? "request disabled prompt caching"
					: "cache lifetime unavailable",
			);
			return;
		}
		const delayMs = getCacheWarmingDelayMs(ttlMs);
		if (delayMs === undefined) {
			this.stop("cache lifetime unavailable");
			return;
		}
		if (restored && restored.lastActivityAt + ttlMs <= Date.now()) {
			this.stop("cache expired before startup");
			return;
		}
		if (restored && mode === "streaming") {
			this.stop("streaming run ended before restart");
			return;
		}
		this.run = {
			...request,
			isCurrent,
			delayMs,
			startedAt: restored?.startedAt ?? Date.now(),
			controller: new AbortController(),
			phase: restored ? "idle" : "streaming",
			spentCost: restored?.spentCost ?? 0,
			nextWarmAt: 0,
			extensionOverride: false,
		};
		this.schedule(this.run, restored?.lastActivityAt);
	}

	onAgentSettled(): void {
		const run = this.run;
		if (!run) return;
		if (this.getMode() === "streaming") {
			this.stop("agent run settled");
			return;
		}
		run.phase = "idle";
		const deadline = run.startedAt + MAX_IDLE_WARMING_AGE_MS;
		if (run.nextWarmAt > deadline || Date.now() >= deadline) {
			this.stop("30-minute idle safety limit reached");
		}
	}

	/** Reconcile an active run after the persisted warming mode changes. */
	onModeChanged(): void {
		const run = this.run;
		if (!run) return;
		const reason = this.getModeStopReason(run);
		if (reason) this.stop(reason);
	}

	cancel(): void {
		this.stop("inactive");
	}

	private clearRun(): void {
		const run = this.run;
		if (!run) return;
		this.run = undefined;
		if (run.timer) clearTimeout(run.timer);
		run.controller.abort();
	}

	private stop(reason: string, stopped?: Pick<CacheWarmingStatus, "decision" | "extensionOverride">): void {
		this.clearRun();
		this.inactive = { state: "inactive", reason, ...stopped };
	}

	private schedule(run: ActiveRun, lastActivityAt = Date.now()): void {
		run.extensionOverride = false;
		run.nextWarmAt = lastActivityAt + run.delayMs;
		const deadline = run.startedAt + (run.phase === "idle" ? MAX_IDLE_WARMING_AGE_MS : MAX_WARMING_AGE_MS);
		if (run.nextWarmAt > deadline || Date.now() >= deadline) {
			this.stop(run.phase === "idle" ? "30-minute idle safety limit reached" : "one-hour safety limit reached");
			return;
		}
		run.timer = setTimeout(() => void this.refresh(run), Math.max(0, run.nextWarmAt - Date.now()));
		run.timer.unref?.();
	}

	private async refresh(run: ActiveRun): Promise<void> {
		run.timer = undefined;
		const modeStopReason = this.getModeStopReason(run);
		if (modeStopReason || !run.isCurrent()) {
			this.stop(modeStopReason ?? "conversation context changed");
			return;
		}
		const decision = this.evaluate(run);
		const { warmCost, missCost, spentCost, continuationProbability } = decision;
		let action = decision.action;
		try {
			action = await this.decide({
				type: "cache_warming_decision",
				warmCost,
				missCost,
				spentCost,
				continuationProbability,
				action,
			});
		} catch {
			// Extension failures fall back to pi's own decision.
		}
		if (this.run !== run) return;
		const extensionOverride = action !== decision.action;
		if (action === "stop") {
			const reason = extensionOverride
				? "stopped by extension"
				: decision.economicsAvailable
					? "expected savings below threshold"
					: "cache economics unavailable";
			this.stop(reason, { decision, extensionOverride });
			return;
		}

		run.extensionOverride = extensionOverride;
		try {
			const message = await this.models
				.streamSimple(run.model, run.context, {
					...run.options,
					maxTokens: 1,
					maxRetries: 0,
					signal: run.controller.signal,
				})
				.result();
			if (this.run !== run) return;
			if (message.stopReason !== "error" && message.stopReason !== "aborted") {
				run.spentCost += message.usage.cost.total;
				const entry = this.sessionManager.appendUsage(
					"cache_warm",
					message.provider,
					message.responseModel ?? message.model,
					message.usage,
					extensionOverride ? "extension override" : undefined,
				);
				this.onWarmed?.(entry);
			}
		} catch {
			// Cache warming is best-effort and must not affect the active agent run.
		}
		if (this.run === run) this.schedule(run);
	}

	private getModeStopReason(run: ActiveRun): string | undefined {
		const mode = this.getMode();
		if (mode === "off") return "cache warming disabled";
		if (mode === "streaming" && run.phase === "idle") return "agent run settled";
		return undefined;
	}

	private evaluate(run: ActiveRun): CacheWarmingDecision {
		const model = run.model;
		const promptTokens = lastPromptTokens(this.sessionManager.getBranch());
		const cacheHitCost = price(model, { cacheRead: promptTokens });
		const cacheMissCost = price(
			model,
			model.cost.cacheWrite > 0 ? { cacheWrite: promptTokens } : { input: promptTokens },
		);
		const warmCost = price(model, { cacheRead: promptTokens, output: 1 });
		const missCost = Math.max(0, cacheMissCost - cacheHitCost);
		const continuationProbability = run.phase === "idle" ? IDLE_CONTINUATION_PROBABILITY : 1;
		const economicsAvailable = promptTokens > 0 && (cacheHitCost > 0 || cacheMissCost > 0);
		const expectedSavings = continuationProbability * missCost - run.spentCost - warmCost;
		return {
			phase: run.phase,
			warmCost,
			missCost,
			spentCost: run.spentCost,
			continuationProbability,
			expectedSavings,
			economicsAvailable,
			action: expectedSavings >= CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS ? "warm" : "stop",
		};
	}
}

function formatDollars(value: number): string {
	return value < 0 ? `-$${Math.abs(value).toFixed(3)}` : `$${value.toFixed(3)}`;
}

function formatCacheWarmingEconomics(decision: CacheWarmingDecision): string {
	if (!decision.economicsAvailable) return "cache economics unavailable";
	const probability = Math.round(decision.continuationProbability * 100);
	const probabilityText =
		decision.phase === "streaming"
			? `${probability}% continuation probability while agent is running`
			: `${probability}% continuation probability`;
	const comparison = decision.action === "warm" ? ">=" : "<";
	return `${probabilityText}, expected savings ${formatDollars(decision.expectedSavings)} ${comparison} $${CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS.toFixed(3)}`;
}

function formatCacheWarmingDecisionTime(nextWarmAt: number | undefined, now: number): string {
	if (nextWarmAt === undefined || nextWarmAt <= now) return "Decision now";
	let remainingSeconds = Math.ceil((nextWarmAt - now) / 1000);
	const hours = Math.floor(remainingSeconds / 3600);
	remainingSeconds %= 3600;
	const minutes = Math.floor(remainingSeconds / 60);
	const seconds = remainingSeconds % 60;
	const parts: string[] = [];
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
	return `Decision in ${parts.join(" ")}`;
}

/** One-line status for `/session`. */
export function formatCacheWarmingStatus(status: CacheWarmingStatus, now = Date.now()): string {
	const decision = status.decision;
	// A decision is attached once pi (or an extension) acted on it; "inactive"
	// without one never got that far.
	if (!decision || (status.state === "inactive" && !decision.economicsAvailable && !status.extensionOverride)) {
		return `Inactive (${status.reason ?? "unknown reason"})`;
	}
	const details = status.extensionOverride
		? `extension override, ${formatCacheWarmingEconomics(decision)}`
		: `${formatCacheWarmingEconomics(decision)} -> ${decision.action}`;
	if (status.state === "inactive") return `Stopped (${details})`;
	if (status.state === "refreshing") return `Warming cache (${details})`;
	return `${formatCacheWarmingDecisionTime(status.nextWarmAt, now)} (${details})`;
}

/** One-line transcript text for persisted cache-warming usage. */
export function formatCacheWarmingUsage(entry: UsageEntry): string {
	const note = entry.note ? ` (${entry.note})` : "";
	const cost = entry.usage.cost.total.toFixed(6).replace(/(\.\d{3}\d*?)0+$/, "$1");
	return `Cache warmed${note}: $${cost}`;
}
