// Prompt cache warming for the session's conversations, as pi-coding-agent does it for its one session: before the
// cache entry a conversation's last request wrote expires, send that request again with a one-token output cap, for as
// long as that is expected to pay off. The policy (when, whether, how) is pi-ai's; this file schedules it per
// conversation.
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
	type Message,
	type Models,
} from "@earendil-works/pi-ai";
import type { ConversationId, GenerationRequest, GenerationResponse } from "@earendil-works/pi-durable";

/** The `cacheWarming` setting: "idle" also warms after a run settled, "streaming" only while it runs. */
export type CacheWarmingMode = "off" | "streaming" | "idle";

/** What the warmers read and do outside themselves; the worker facet binds it to the Harness and the settings. */
export type WarmerHost = {
	/** The `cacheWarming` setting now. */
	mode(): CacheWarmingMode;
	now(): number;
	/** Arms a timer and returns its cancel. */
	setTimer(fn: () => void, delayMs: number): () => void;
	/** Whether the conversation's next request still starts with `request`: same model, a context extending its messages. */
	isCurrent(conversationId: ConversationId, request: GenerationRequest): Promise<boolean>;
	/** Whether a run is under way in the conversation. */
	running(conversationId: ConversationId): Promise<boolean>;
	/** Whether the conversation is warmed after its run settled: top-level conversations, not subagents. */
	warmsIdle(conversationId: ConversationId): Promise<boolean>;
	/** Adds a refresh's spend to the conversation's usage. */
	record(conversationId: ConversationId, message: AssistantMessage): Promise<void>;
	/** Counts the conversations being warmed; a count keeps the worker process alive. */
	keepAlive(delta: number): void;
	report(error: unknown): void;
};

type Run = {
	readonly request: GenerationRequest;
	readonly models: Models;
	/** Prompt size of the request, as the provider reported it. */
	readonly promptTokens: number;
	readonly ttlMs: number;
	readonly delayMs: number;
	readonly startedAt: number;
	readonly controller: AbortController;
	phase: CacheWarmingPhase;
	/** Latest time the armed refresh may still be sent, leaving half the planned margin before expiry. */
	refreshDeadlineAt: number;
	cancelTimer?: () => void;
};

/**
 * One warming run per conversation, started by each response (`afterResponse`) and replaced by the next one. A run
 * refreshes while its conversation's run streams (up to an hour after the request) and, in mode "idle", for up to 30
 * minutes after it settled, while each refresh pays off by pi-ai's `evaluateCacheWarming()`.
 */
export class ConversationWarmers {
	readonly #host: WarmerHost;
	readonly #runs = new Map<ConversationId, Run>();

	constructor(host: WarmerHost) {
		this.#host = host;
	}

	/** Warm the cache entry `response`'s request wrote, replacing the conversation's run; `models` sends the refreshes. */
	start(conversationId: ConversationId, response: GenerationResponse, models: Models): void {
		this.stop(conversationId);
		const { message, request } = response;
		// A polled deferred response sent no request; a failed or aborted one wrote no entry worth keeping, and its run
		// is over.
		if (request === undefined || message.stopReason === "error" || message.stopReason === "aborted") return;
		if (this.#host.mode() === "off" || request.payloadReplaced) return;
		if (!isCacheWarmingReplayable(request.model, request.options)) return;
		const ttlMs = getPromptCacheTtlMs(request.model, request.options);
		const delayMs = ttlMs === undefined ? undefined : getCacheWarmingDelayMs(ttlMs);
		if (ttlMs === undefined || delayMs === undefined) return;
		const usage = message.usage;
		const run: Run = {
			request,
			models,
			promptTokens: usage.input + usage.cacheRead + usage.cacheWrite,
			ttlMs,
			delayMs,
			startedAt: this.#host.now(),
			controller: new AbortController(),
			phase: "streaming",
			refreshDeadlineAt: 0,
		};
		this.#runs.set(conversationId, run);
		this.#host.keepAlive(1);
		this.#schedule(conversationId, run);
	}

	/** The conversation's run answered (`afterRun`): warm on as idle, or stop in mode "streaming". */
	settled(conversationId: ConversationId): void {
		const run = this.#runs.get(conversationId);
		if (run === undefined) return;
		if (this.#host.mode() === "idle") run.phase = "idle";
		else this.stop(conversationId);
	}

	/** Stop warming the conversation; a refresh in flight is aborted. */
	stop(conversationId: ConversationId): void {
		const run = this.#runs.get(conversationId);
		if (run === undefined) return;
		this.#runs.delete(conversationId);
		run.cancelTimer?.();
		run.controller.abort();
		this.#host.keepAlive(-1);
	}

	/** Stop every run (a reload or the worker's stop). */
	close(): void {
		for (const conversationId of [...this.#runs.keys()]) this.stop(conversationId);
	}

	#schedule(conversationId: ConversationId, run: Run): void {
		const now = this.#host.now();
		const nextAt = now + run.delayMs;
		const maxAge = run.phase === "idle" ? CACHE_WARMING_MAX_IDLE_AGE_MS : CACHE_WARMING_MAX_AGE_MS;
		if (nextAt > run.startedAt + maxAge) {
			this.stop(conversationId);
			return;
		}
		// A timer can fire late after sleep or a blocked event loop; a refresh past this point would likely be a
		// full-price cache write, not a warm.
		run.refreshDeadlineAt = nextAt + Math.floor((run.ttlMs - run.delayMs) / 2);
		run.cancelTimer = this.#host.setTimer(() => void this.#refresh(conversationId, run), run.delayMs);
	}

	async #refresh(conversationId: ConversationId, run: Run): Promise<void> {
		run.cancelTimer = undefined;
		try {
			if (!(await this.#shouldRefresh(conversationId, run))) {
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
			if (!run.controller.signal.aborted) this.#host.report(error);
		}
		if (this.#runs.get(conversationId) === run) this.#schedule(conversationId, run);
	}

	/** Whether the armed refresh is still wanted: the run current, in its window, and paying off. */
	async #shouldRefresh(conversationId: ConversationId, run: Run): Promise<boolean> {
		const mode = this.#host.mode();
		if (mode === "off" || this.#runs.get(conversationId) !== run) return false;
		if (this.#host.now() > run.refreshDeadlineAt) return false;
		// A run that ended without an answer (aborted during its tools, a turn limit) never called `afterRun`.
		if (run.phase === "streaming" && !(await this.#host.running(conversationId))) run.phase = "idle";
		if (run.phase === "idle") {
			if (mode !== "idle" || !(await this.#host.warmsIdle(conversationId))) return false;
			if (this.#host.now() > run.startedAt + CACHE_WARMING_MAX_IDLE_AGE_MS) return false;
		}
		if (!(await this.#host.isCurrent(conversationId, run.request))) return false;
		const decision = evaluateCacheWarming(run.request.model, run.promptTokens, run.phase);
		return decision.action === "warm" && this.#runs.get(conversationId) === run;
	}
}

/**
 * Whether `current` (a conversation's model context now) starts with `sent` (the messages a request sent): the same
 * messages by role and timestamp, so no reset, compaction or edit replaced any of them.
 */
export function extendsMessages(current: readonly Message[], sent: readonly Message[]): boolean {
	if (current.length < sent.length) return false;
	return sent.every(
		(message, index) => current[index]!.role === message.role && current[index]!.timestamp === message.timestamp,
	);
}
