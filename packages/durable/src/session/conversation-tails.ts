// The newest entry and newest head marker of each recently used conversation, kept current from the Session's commits.
import type { ConversationId, EntryId, EntryRecord, StorageWrite } from "../types.ts";

/** An entry that carries a `head`: the marker of a context range. */
export type HeadMarker = EntryRecord & { readonly head: EntryId };

/** Conversations whose newest entry ID is kept: IDs only, so many. */
const LATEST_CAPACITY = 4096;

/** Conversations whose newest head marker is kept: whole entries (a compaction summary is one), so fewer. */
const MARKER_CAPACITY = 256;

/**
 * The newest entry ID and newest head marker per conversation, for the Session that owns its Storage: every entry is
 * written by one of its commits, so `apply` keeps both current, and a value read from Storage stays valid until the
 * next entry of that conversation. Read only on the Session line after touching the conversation's appends, so no
 * commit that appends to it is unpublished and a value read from Storage can be kept. The newest entry visible from a conversation is its own newest, or for a fork without entries
 * of its own the parent's entry at the fork point: IDs grow, so a conversation's own new entry is always the newest.
 * Each map is bounded by a count, the least recently used conversation leaving first. Kept markers are frozen: entry
 * records are immutable (`Tx.appendEntry()`).
 */
export class ConversationTails {
	/** Newest entry ID per conversation, `null` for none. */
	readonly #latest = new Map<ConversationId, EntryId | null>();
	/** Newest head marker per conversation, `null` for none. */
	readonly #markers = new Map<ConversationId, HeadMarker | null>();

	/** The newest entry ID visible from `conversationId`, read with `read` when not known. */
	async latest(
		conversationId: ConversationId,
		read: () => Promise<EntryId | undefined>,
	): Promise<EntryId | undefined> {
		const known = use(this.#latest, conversationId);
		if (known !== undefined) return known ?? undefined;
		const latest = await read();
		put(this.#latest, conversationId, latest ?? null, LATEST_CAPACITY);
		return latest;
	}

	/**
	 * The newest visible head marker at or before `atOrBefore` (any when `undefined`), read with `read` when not known.
	 * The newest marker answers every cutoff at or after it, and no marker answers every cutoff.
	 */
	async marker(
		conversationId: ConversationId,
		atOrBefore: EntryId | undefined,
		read: () => Promise<HeadMarker | undefined>,
	): Promise<HeadMarker | undefined> {
		const marker = use(this.#markers, conversationId);
		if (marker === null) return undefined;
		if (marker !== undefined && (atOrBefore === undefined || atOrBefore >= marker.id)) return marker;
		const latest = this.#latest.get(conversationId);
		const found = await read();
		// Only a read that no newer entry can change: no cutoff, or one at or after the newest entry.
		if (atOrBefore === undefined || (latest !== undefined && (latest ?? 0) <= atOrBefore)) {
			put(this.#markers, conversationId, found === undefined ? null : freeze(found), MARKER_CAPACITY);
		}
		return found;
	}

	/** The newest entry ID of `conversationId` if known, without reading: `null` for none, `undefined` when unknown. */
	peek(conversationId: ConversationId): EntryId | null | undefined {
		return this.#latest.get(conversationId);
	}

	/** At a commit's publication: apply a durable batch. */
	apply(writes: readonly StorageWrite[]): void {
		for (const write of writes) {
			if (write.type === "conversation") {
				// A new root conversation sees no entries; a fork sees its parent's up to the fork point.
				if (write.value.parent !== undefined) continue;
				put(this.#latest, write.value.id, null, LATEST_CAPACITY);
				put(this.#markers, write.value.id, null, MARKER_CAPACITY);
			} else if (write.type === "entry") {
				const entry = write.value;
				put(this.#latest, entry.conversationId, entry.id, LATEST_CAPACITY);
				if (entry.head !== undefined) {
					put(this.#markers, entry.conversationId, freeze(entry as HeadMarker), MARKER_CAPACITY);
				}
			}
		}
	}

	/** How many conversations have their newest entry kept, for tests that bound memory. */
	get size(): number {
		return this.#latest.size;
	}

	/** How many conversations have their newest head marker kept, for tests that bound memory. */
	get markers(): number {
		return this.#markers.size;
	}
}

/** `map`'s value for `key`, made the most recently used. */
function use<K, V>(map: Map<K, V>, key: K): V | undefined {
	const value = map.get(key);
	if (value === undefined) return undefined;
	map.delete(key);
	map.set(key, value);
	return value;
}

/** Set `key` as the most recently used, dropping the least recently used beyond `capacity`. */
function put<K, V>(map: Map<K, V>, key: K, value: V, capacity: number): void {
	map.delete(key);
	map.set(key, value);
	if (map.size > capacity) map.delete(map.keys().next().value!);
}

function freeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) freeze(child);
	return Object.freeze(value);
}
