import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type CommitChange,
	type CommitPublication,
	type CommitResult,
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
	type Storage,
	type StorageWrite,
} from "@earendil-works/pi-durable";
import { type ObservedCommit, SessionImpl } from "../src/session/session.ts";

export const context: Context = BACKGROUND_CONTEXT;

/**
 * A watch listener for value calls: Durable's watches never send a `failed` call (their failures end them), so one here
 * throws, which ends the watch `listener_error`.
 */
export function onValue<C extends { readonly kind: string }>(
	listener: (call: Extract<C, { readonly kind: "value" }>, context: Context) => Promise<void>,
): (call: C, context: Context) => Promise<void> {
	return (call, deliveryContext) => {
		if (call.kind !== "value") throw new Error(`Unexpected ${call.kind} watch call`);
		return listener(call as Extract<C, { readonly kind: "value" }>, deliveryContext);
	};
}

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

/**
 * Commits `batches` through `commit` up to the first one `refuses` matches, which it refuses with `error`: what a
 * storage does whose own check refuses that batch.
 */
export async function refusingAt(
	commit: Storage["commit"],
	batches: readonly (readonly StorageWrite[])[],
	receive: (index: number, seq: Seq) => void,
	commitContext: Context,
	refuses: (writes: readonly StorageWrite[]) => boolean,
	error: unknown,
): Promise<CommitResult> {
	const at = batches.findIndex(refuses);
	if (at < 0) return commit(batches, receive, commitContext);
	const result = await commit(batches.slice(0, at), receive, commitContext);
	return result.stored < at ? result : { stored: at, refused: error };
}

/** Memory storage with observable commits, held calls, and injected commit failures. */
export class ControlledStorage extends MemoryStorage {
	/** Exact borrowed batches admitted by Session. */
	readonly admittedCommits: (readonly StorageWrite[])[] = [];
	/** Detached batches for value assertions. */
	readonly commits: (readonly StorageWrite[])[] = [];
	mintCount = 0;
	documentReadCount = 0;
	/** Set while a receipt runs, the storage's synchronous step: code that sees it set runs inside `commit()`'s `receive`. */
	adopting = false;
	/** Runs once, in the next commit's synchronous step right after its first receipt returned. */
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

	/**
	 * Records and holds the call, then fails its first batch if a failure is set (a refusal: nothing stored), or commits
	 * it in memory, `adopting` set while each receipt runs and `afterAdopt` run after the first one.
	 */
	override async commit(
		batches: readonly (readonly StorageWrite[])[],
		receive: (index: number, seq: Seq) => void,
		commitContext: Context,
	): Promise<CommitResult> {
		const held = this.#commitGate;
		if (held !== undefined) {
			held.entered.resolve();
			await held.gate.promise;
		}
		const failure = this.#commitFailure;
		for (const writes of failure === undefined ? batches : batches.slice(0, 1)) {
			this.admittedCommits.push(writes);
			this.commits.push(structuredClone(writes));
		}
		if (failure !== undefined) {
			this.#commitFailure = undefined;
			return { stored: 0, refused: failure };
		}
		const step = (index: number, seq: Seq): void => {
			this.adopting = true;
			try {
				receive(index, seq);
			} finally {
				this.adopting = false;
			}
			const after = this.afterAdopt;
			this.afterAdopt = undefined;
			after?.();
		};
		return super.commit(batches, step, commitContext);
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

	override async commit(
		batches: readonly (readonly StorageWrite[])[],
		receive: (index: number, seq: Seq) => void,
		commitContext: Context,
	): Promise<CommitResult> {
		this.committing = true;
		try {
			const result = await super.commit(batches, receive, commitContext);
			const stored = batches.slice(0, result.stored);
			await flush();
			if (stored.some((writes) => this.gap?.(writes) === true)) {
				this.gap = undefined;
				// What the gap started runs before the commit resolves.
				await flush();
			}
			if (stored.some((writes) => this.rejectAfterAdopt?.(writes) === true)) {
				this.rejectAfterAdopt = undefined;
				throw new Error("reclaim failed");
			}
			return result;
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
	session.observeCommits({
		advance: (publication) => {
			publications.push(publication);
		},
		end: () => {},
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
 * Follow every commit as memory adopts it, deferred ones before they are stored, as views and document watches do;
 * `observeCommits()` sees only what was stored.
 */
export function followCommits(
	session: Session,
	listener: (publication: ObservedCommit, context: Context) => void,
): () => void {
	// `followCommits()` is internal, so the public type lacks it; every Session and Harness is a `SessionImpl`.
	return (session as unknown as SessionImpl).followCommits(listener);
}

/** The document changes of `publication` that carry a value: creations and updates, no retirements. */
export function documentValues(publication: {
	readonly changes: readonly CommitChange[];
}): readonly Extract<DocumentCommitChange, { readonly kind: "change" }>[] {
	return publication.changes.filter(
		(change): change is Extract<DocumentCommitChange, { readonly kind: "change" }> =>
			change.type === "document" && change.kind === "change",
	);
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
