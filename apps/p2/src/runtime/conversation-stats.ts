// Numbers about a conversation's active context, which the worker keeps: the estimated context size and the latest
// response's usage (from the entries its view's window appends), and each response's cost (from Durable's
// `Conversation.context()`). A client holds only a window of the transcript (`Chat.view`), so it gets them from the
// worker (`Chat.stats`, `ChatCosts`).
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import {
	calculateContextTokens,
	estimateContextTokens,
	estimateMessageTokens,
} from "@earendil-works/pi-ai/utils/estimate";
import type { ContextView, ConversationView, EntryRecord } from "@earendil-works/pi-durable";

export type AssistantCost = {
	entryId: string;
	timestamp: number;
	cost: number;
	/** Undefined when the response reported no prompt tokens. */
	cacheHit: number | undefined;
	provider: string;
	model: string;
	stopReason: string;
};

/** Share of prompt tokens served from the provider cache, or undefined without prompt tokens. */
export function cacheHitRate(usage: Usage): number | undefined {
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	return prompt > 0 ? usage.cacheRead / prompt : undefined;
}

export type ActiveStats = {
	/** Estimated size of the active context, not cumulative usage across requests. */
	contextTokens: number;
	/** Last committed assistant response of the active range, never session-wide totals or live partials. */
	latestAssistantUsage?: Usage;
};

/**
 * The active context's numbers, kept up to date from the entries appended to it: pi-ai's estimate (the latest
 * response's reported usage, plus an estimate of what follows it) and the latest response's usage. A whole context
 * (`Conversation.context()`, a read of every active entry) is needed only when the active range changes in another way.
 */
export class ContextTally {
	/** Context tokens the latest counted response reported, 0 before one. */
	#usage = 0;
	/** Estimated tokens of the messages after it. */
	#trailing = 0;
	#latest: Usage | undefined;
	/** The newest entry ID taken. */
	#seen = Number.NEGATIVE_INFINITY;

	get stats(): ActiveStats {
		return {
			contextTokens: this.#usage + this.#trailing,
			...(this.#latest ? { latestAssistantUsage: this.#latest } : {}),
		};
	}

	/** Starts over from a whole active context. */
	reset(context: ContextView): void {
		const estimate = estimateContextTokens(context.messages);
		this.#usage = estimate.usageTokens;
		this.#trailing = estimate.trailingTokens;
		this.#latest = undefined;
		this.#seen = Number.NEGATIVE_INFINITY;
		for (const entry of context.entries) {
			const message = entry.model?.[0];
			if (message?.role === "assistant") this.#latest = message.usage;
			this.#seen = Math.max(this.#seen, entry.id);
		}
	}

	/**
	 * Takes the entries of a view's window newer than the newest taken. False when they do not simply append to the
	 * active context, so a whole one is needed: the window skipped entries (`before` past the newest taken), or one
	 * starts a new head (a compaction summary, a reset) or edits earlier entries.
	 */
	advance(view: ConversationView): boolean {
		if (view.before !== undefined && view.before > this.#seen) return false;
		let first = view.entries.length;
		while (first > 0 && view.entries[first - 1]!.id > this.#seen) first--;
		for (const entry of view.entries.slice(first)) {
			if (entry.head !== undefined || entry.edits?.length) return false;
			for (const message of entry.model ?? []) this.#take(message);
			this.#seen = entry.id;
		}
		return true;
	}

	/** One message appended to the context, as pi-ai's estimate and Durable's context count it. */
	#take(message: Message): void {
		if (message.role !== "assistant") {
			this.#trailing += estimateMessageTokens(message);
			return;
		}
		this.#latest = message.usage;
		// Durable leaves these responses out of the model's context.
		if (message.stopReason === "aborted" || message.stopReason === "error" || message.stopReason === "deferred")
			return;
		const reported = calculateContextTokens(message.usage);
		if (reported > 0) {
			this.#usage = reported;
			this.#trailing = 0;
		} else this.#trailing += estimateMessageTokens(message);
	}
}

/** Each response of the active entries with its cost, in commit order. */
export function responseCosts(entries: readonly EntryRecord[]): AssistantCost[] {
	return entries.flatMap((entry) => {
		const message = entry.model?.[0];
		if (message?.role !== "assistant") return [];
		const response = message as AssistantMessage;
		return [
			{
				entryId: String(entry.id),
				timestamp: response.timestamp,
				cost: response.usage.cost.total,
				cacheHit: cacheHitRate(response.usage),
				provider: response.provider,
				model: response.model,
				stopReason: response.stopReason,
			},
		];
	});
}
