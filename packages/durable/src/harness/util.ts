import type { Context } from "@earendil-works/chord";
import { SessionFailed } from "../errors.ts";
import type { ConversationId, Cursor, EntryQuery, Page } from "../types.ts";

/** Pending waits by key. Each settles once: through `resolve`, `rejectAll`, or cancellation of its context. */
export class Waiters<K, T> {
	readonly #sets = new Map<K, Set<PromiseWithResolvers<T>>>();

	add(key: K, context: Context): Promise<T> {
		const signal = context.abortSignal;
		if (signal?.aborted) return Promise.reject(signal.reason);
		const waiter = Promise.withResolvers<T>();
		const set = this.#sets.get(key) ?? new Set();
		this.#sets.set(key, set.add(waiter));
		if (signal !== undefined) {
			const onAbort = (): void => {
				set.delete(waiter);
				if (set.size === 0 && this.#sets.get(key) === set) this.#sets.delete(key);
				waiter.reject(signal.reason);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			const detach = (): void => signal.removeEventListener("abort", onAbort);
			waiter.promise.then(detach, detach);
		}
		return waiter.promise;
	}

	keys(): K[] {
		return [...this.#sets.keys()];
	}

	resolve(key: K, value: T): void {
		const set = this.#sets.get(key);
		this.#sets.delete(key);
		for (const waiter of set ?? []) waiter.resolve(value);
	}

	rejectAll(error: unknown): void {
		const sets = [...this.#sets.values()];
		this.#sets.clear();
		for (const set of sets) for (const waiter of set) waiter.reject(error);
	}
}

/** Every item of a paginated scan, in page order. */
export async function scanAll<T>(scan: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>): Promise<T[]> {
	const items: T[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await scan(cursor);
		items.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	return items;
}

/** What a closed Harness rejects with: `SessionFailed` with the cause when it closed because the Session failed. */
export function closedError(session: { readonly failure: { readonly error: unknown } | undefined }): Error {
	const failure = session.failure;
	return failure === undefined ? new Error("Harness is closed") : new SessionFailed(failure.error);
}

/** `{ extension }` when the extension is known. */
export function optionalExtension(extension: string | undefined): { readonly extension?: string } {
	return extension === undefined ? {} : { extension };
}

/** The scan of conversation `conversationId`'s history that `query` asks for, without fields an untyped caller added. */
export function conversationEntries(
	conversationId: ConversationId,
	query: Omit<EntryQuery, "conversationId">,
): EntryQuery {
	return {
		conversationId,
		...(query.minEntryId === undefined ? {} : { minEntryId: query.minEntryId }),
		...(query.maxEntryId === undefined ? {} : { maxEntryId: query.maxEntryId }),
		...(query.order === undefined ? {} : { order: query.order }),
	};
}
