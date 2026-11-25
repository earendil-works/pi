// Prompt cache warming for the session's conversations, as pi-coding-agent does it for its one session: before the
// cache entry a conversation's last request wrote expires, send that request again with a one-token output cap, for as
// long as that is expected to pay off. The policy is pi-ai's; this file schedules it per conversation.
import {
	type AssistantMessage,
	CACHE_WARMING_MAX_AGE_MS,
	CACHE_WARMING_MAX_IDLE_AGE_MS,
	type CacheWarmingPhase,
	evaluateCacheWarming,
	getCacheWarmingDelayMs,
	getCacheWarmingRequestOptions,
	getPromptCacheTtlMs,
	isCacheWarmingReplayable,
	type Models,
} from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ModelRequest } from "@p2/app/v1/worker";

/** The `cacheWarming` setting: "idle" also warms after a run settled, "streaming" only while it runs. */
export type CacheWarmingMode = "off" | "streaming" | "idle";

/** What the warmers read and do outside themselves; the worker facet binds it to the Harness and the settings. */
export type WarmerHost = {
	mode(): CacheWarmingMode;
	/**
	 * "streaming" while the conversation's run is under way, "idle" after it, or `undefined` when warming the
	 * conversation is pointless: its next request will not start with `request`, or nobody is expected to continue it.
	 */
	phase(conversationId: ConversationId, request: ModelRequest): Promise<CacheWarmingPhase | undefined>;
	/** Adds a refresh's spend to the conversation's usage. */
	record(conversationId: ConversationId, message: AssistantMessage): Promise<void>;
	/** Counts the conversations being warmed; a count keeps the worker process alive. */
	keepAlive(delta: number): void;
};

type Run = {
	readonly request: ModelRequest;
	readonly models: Models;
	/** Prompt size of the request, as the provider reported it. */
	readonly promptTokens: number;
	readonly delayMs: number;
	readonly startedAt: number;
	readonly controller: AbortController;
	timer?: ReturnType<typeof setTimeout>;
};

/**
 * One warming run per conversation, started by each response and replaced by the next one. Each refresh asks the host
 * for the conversation's phase and refreshes while the request is at most an hour old (30 minutes once idle) and the
 * refresh pays off by pi-ai's `evaluateCacheWarming()`.
 */
export class ConversationWarmers {
	readonly #host: WarmerHost;
	readonly #runs = new Map<ConversationId, Run>();

	constructor(host: WarmerHost) {
		this.#host = host;
	}

	/**
	 * Warm the cache entry `request` wrote, replacing the conversation's run: `message` is its response, `models` sends
	 * the refreshes.
	 */
	start(conversationId: ConversationId, message: AssistantMessage, request: ModelRequest, models: Models): void {
		this.stop(conversationId);
		// A failed or aborted response ended its run.
		if (message.stopReason === "error" || message.stopReason === "aborted") return;
		// Mode "off" uninstalls the hook; a run already armed stops at its next refresh.
		if (!isCacheWarmingReplayable(request.model, request.options)) return;
		const ttlMs = getPromptCacheTtlMs(request.model, request.options);
		const delayMs = ttlMs === undefined ? undefined : getCacheWarmingDelayMs(ttlMs);
		if (delayMs === undefined) return;
		const { input, cacheRead, cacheWrite } = message.usage;
		const run: Run = {
			request,
			models,
			promptTokens: input + cacheRead + cacheWrite,
			delayMs,
			startedAt: Date.now(),
			controller: new AbortController(),
		};
		this.#runs.set(conversationId, run);
		this.#host.keepAlive(1);
		run.timer = setTimeout(() => void this.#refresh(conversationId, run), delayMs);
	}

	/** Stop warming the conversation; a refresh in flight is aborted. */
	stop(conversationId: ConversationId): void {
		const run = this.#runs.get(conversationId);
		if (run === undefined) return;
		this.#runs.delete(conversationId);
		clearTimeout(run.timer);
		run.controller.abort();
		this.#host.keepAlive(-1);
	}

	/** Stop every run (a reload or the worker's stop). */
	close(): void {
		for (const conversationId of [...this.#runs.keys()]) this.stop(conversationId);
	}

	async #refresh(conversationId: ConversationId, run: Run): Promise<void> {
		try {
			if (!(await this.#wanted(conversationId, run))) {
				if (this.#runs.get(conversationId) === run) this.stop(conversationId);
				return;
			}
			const { model, messages, options } = run.request;
			const message = await run.models.completeSimple(
				model,
				{ messages: [...messages] },
				getCacheWarmingRequestOptions(options, run.controller.signal),
			);
			if (this.#runs.get(conversationId) !== run) return;
			if (message.stopReason !== "error" && message.stopReason !== "aborted")
				await this.#host.record(conversationId, message);
		} catch (error) {
			// Warming is best effort: a failed refresh never touches the conversation, the next one may succeed.
			if (!run.controller.signal.aborted) console.error("p2 cache-warming: refreshing failed:", error);
		}
		if (this.#runs.get(conversationId) === run)
			run.timer = setTimeout(() => void this.#refresh(conversationId, run), run.delayMs);
	}

	/** Whether this refresh is still wanted: the run current, in its phase's window, and paying off. */
	async #wanted(conversationId: ConversationId, run: Run): Promise<boolean> {
		const mode = this.#host.mode();
		if (mode === "off") return false;
		const phase = await this.#host.phase(conversationId, run.request);
		if (phase === undefined || (phase === "idle" && mode === "streaming")) return false;
		const maxAge = phase === "idle" ? CACHE_WARMING_MAX_IDLE_AGE_MS : CACHE_WARMING_MAX_AGE_MS;
		if (Date.now() > run.startedAt + maxAge) return false;
		const { action } = evaluateCacheWarming(run.request.model, run.promptTokens, phase);
		return action === "warm" && this.#runs.get(conversationId) === run;
	}
}
