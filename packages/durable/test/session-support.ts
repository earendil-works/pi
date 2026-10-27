import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type CommitChange,
	type CommitPublication,
	type ConversationId,
	type DocumentAddress,
	type DocumentCommitChange,
	type DocumentId,
	type DocumentPoint,
	type DocumentRecord,
	type Id,
	MemoryStorage,
	type Seq,
	type Session,
	type StorageWrite,
} from "@earendil-works/pi-durable";
import { type ObservedCommit, SessionImpl } from "../src/session/session.ts";

export const context: Context = BACKGROUND_CONTEXT;

type Deferred = { readonly promise: Promise<void>; readonly resolve: () => void };

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** A gate that holds calls until released and reports when the first held call arrives. */
export type Gate = {
	readonly entered: Promise<void>;
	release(): void;
};

/** Memory storage with observable commits, held calls, and injected commit failures. */
export class ControlledStorage extends MemoryStorage {
	/** Exact borrowed batches admitted by Session. */
	readonly admittedCommits: (readonly StorageWrite[])[] = [];
	/** Detached batches for value assertions. */
	readonly commits: (readonly StorageWrite[])[] = [];
	mintCount = 0;
	documentReadCount = 0;
	/** Set while `adopt` runs, the storage's synchronous step: code that sees it set runs inside `Storage.commit()`'s adopt. */
	adopting = false;
	/** Runs once, in the next commit's synchronous step right after `adopt` returned. */
	afterAdopt: (() => void) | undefined;
	#commitGate: { gate: Deferred; entered: Deferred } | undefined;
	#findGate: { gate: Deferred; entered: Deferred } | undefined;
	#commitFailure: Error | undefined;

	holdCommits(): Gate {
		const held = { gate: deferred(), entered: deferred() };
		this.#commitGate = held;
		return { entered: held.entered.promise, release: () => this.#release("commit", held) };
	}

	holdFindDocument(): Gate {
		const held = { gate: deferred(), entered: deferred() };
		this.#findGate = held;
		return { entered: held.entered.promise, release: () => this.#release("find", held) };
	}

	/** Simulate a crash during the held commit: it never reaches storage, and later commits proceed. */
	crash(): void {
		this.#commitGate = undefined;
	}

	failNextCommit(error: Error): void {
		this.#commitFailure = error;
	}

	/** Reopen after `close()`, as a fresh process would reopen the same database, keeping every committed record. */
	reopen(): this {
		(this as unknown as { closed: boolean }).closed = false;
		return this;
	}

	#release(kind: "commit" | "find", held: { gate: Deferred }): void {
		if (kind === "commit" && this.#commitGate === held) this.#commitGate = undefined;
		if (kind === "find" && this.#findGate === held) this.#findGate = undefined;
		held.gate.resolve();
	}

	override async commit(
		writes: readonly StorageWrite[],
		adopt: (seq: Seq) => void,
		commitContext: Context,
	): Promise<Seq> {
		this.admittedCommits.push(writes);
		this.commits.push(structuredClone(writes));
		const held = this.#commitGate;
		if (held !== undefined) {
			held.entered.resolve();
			await held.gate.promise;
		}
		const failure = this.#commitFailure;
		if (failure !== undefined) {
			this.#commitFailure = undefined;
			throw failure;
		}
		const step = (seq: Seq): void => {
			this.adopting = true;
			try {
				adopt(seq);
			} finally {
				this.adopting = false;
			}
			const after = this.afterAdopt;
			this.afterAdopt = undefined;
			after?.();
		};
		return super.commit(writes, step, commitContext);
	}

	override mintId<I extends Id<string>>(): Promise<I> {
		this.mintCount++;
		return super.mintId<I>();
	}

	override document(id: DocumentId, at: DocumentPoint, callContext: Context) {
		this.documentReadCount++;
		return super.document(id, at, callContext);
	}

	override async findDocument(
		address: DocumentAddress,
		at: DocumentPoint,
		callContext: Context,
	): Promise<DocumentRecord | undefined> {
		const held = this.#findGate;
		if (held !== undefined) {
			held.entered.resolve();
			await held.gate.promise;
		}
		return super.findDocument(address, at, callContext);
	}
}

/**
 * Controlled storage whose commits resolve a macrotask after they adopted the batch, as a storage with work after
 * durability does (JSONL reclaims sidecars): code woken inside `adopt` runs before the commit resolves. `gap` runs in
 * that work, a macrotask after adoption, and `rejectAfterAdopt` makes a commit it matches reject there, durable and
 * adopted, as a failed reclaim does; each fires once.
 */
export class LateResolvingStorage extends ControlledStorage {
	/** Set from a commit's start until it resolves. */
	committing = false;
	gap: ((writes: readonly StorageWrite[]) => boolean) | undefined;
	rejectAfterAdopt: ((writes: readonly StorageWrite[]) => boolean) | undefined;

	override async commit(writes: readonly StorageWrite[], adopt: (seq: Seq) => void, commitContext: Context) {
		this.committing = true;
		try {
			const seq = await super.commit(writes, adopt, commitContext);
			await flush();
			if (this.gap?.(writes) === true) {
				this.gap = undefined;
				// What the gap started runs before the commit resolves.
				await flush();
			}
			if (this.rejectAfterAdopt?.(writes) === true) {
				this.rejectAfterAdopt = undefined;
				throw new Error("reclaim failed");
			}
			return seq;
		} finally {
			this.committing = false;
		}
	}
}

/** Session kernel plus its controlled storage and every committed publication. */
export function openTestSession(): {
	readonly storage: ControlledStorage;
	readonly session: SessionImpl;
	readonly publications: CommitPublication[];
} {
	const storage = new ControlledStorage();
	// These tests pin the cache's identities and loads, so documents stay as long as the default keeps them.
	const session = new SessionImpl(storage, Date.now, () => 600_000);
	const publications: CommitPublication[] = [];
	session.subscribeCommits((publication) => {
		publications.push(publication);
	});
	return { storage, session, publications };
}

export function documentChanges(publication: {
	readonly changes: readonly CommitChange[];
}): readonly Extract<DocumentCommitChange, { readonly type: "document" }>[] {
	return publication.changes.filter(
		(change): change is Extract<DocumentCommitChange, { readonly type: "document" }> => change.type === "document",
	);
}

/**
 * Observe every commit as memory adopts it, deferred ones before they are stored, as views and document watches do;
 * `subscribeCommits()` sees only what was stored.
 */
export function observeCommits(
	session: Session,
	listener: (publication: ObservedCommit, context: Context) => void,
): () => void {
	// `observeCommits()` is internal, so the public type lacks it; every Session and Harness is a `SessionImpl`.
	return (session as unknown as SessionImpl).observeCommits(listener);
}

export function documentCopyChanges(
	publication: CommitPublication,
): readonly Extract<DocumentCommitChange, { readonly type: "document.copy" }>[] {
	return publication.changes.filter(
		(change): change is Extract<DocumentCommitChange, { readonly type: "document.copy" }> =>
			change.type === "document.copy",
	);
}

/** Create one conversation and return its ID. */
export async function createConversation(session: SessionImpl): Promise<ConversationId> {
	return session.commit(async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id, context);
}

/** Resolve after pending microtasks and one macrotask turn. */
export function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}
