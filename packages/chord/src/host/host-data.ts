// Host data operations on a live host (decision "Documents and table rows can belong to a host"; spec
// `docs/host-keyed/spec.md` §5): the gate that serializes them and keeps activations' load phases out while one runs,
// and the coordination of one import or delete with the live objects owning data of the address: their lines held,
// what they hold of it read again inside the commit step, and adopted in one host batch after `COMMIT`.

import { awaitWithContext, type Context, withoutAbortSignal } from "../context/index.ts";
import type { Address } from "../contracts/index.ts";
import { kindOfKey } from "../contracts/internal.ts";
import type { ChordError } from "../data/index.ts";
import { invalid } from "../data/internal.ts";
import type { ChangedDocument, Documents, KeyedSlot } from "../documents/internal.ts";
import type { Batch } from "../state/internal.ts";
import {
	deleteHostData,
	type HostCommit,
	type HostDataCounts,
	type HostImportOptions,
	hostDataOwners,
	importHostData,
	readHostArchive,
	tablesToMigrate,
} from "../store/host-data.ts";
import type { LiveQueries, LiveQuery } from "../store/live-query.ts";
import type { StagedWrite } from "../store/step.ts";
import type { ChordStore } from "../store/store.ts";
import type { TableDefinition } from "../store/table.ts";
import { storedText } from "../store/text.ts";

/**
 * The host data gate: operations (writers) one at a time in call order; activations' load phases (readers) while none
 * is exclusive. A writer becomes exclusive after its preparation (which may activate owners, as readers) and waits for
 * the load phases under way; activations arriving meanwhile wait until it ends.
 */
export class HostDataGate {
	/** The turn of the operation after the last one queued. */
	#tail: Promise<void> = Promise.resolve();
	#readers = 0;
	/** Whether an operation is exclusive (readers wait). */
	#isExclusive = false;
	/** Readers waiting for the exclusive operation's end; the operation waiting for the readers. */
	#opened: (() => void)[] = [];
	#drained: (() => void) | undefined;

	/**
	 * Enters an activation's load phase: at once (`undefined`, no extra turn on the common path) unless an operation is
	 * exclusive; then the returned promise resolves once it ended. Every entry is paired with `leave`.
	 */
	enter(): Promise<void> | undefined {
		if (!this.#isExclusive) {
			this.#readers++;
			return undefined;
		}
		return (async () => {
			while (this.#isExclusive) await new Promise<void>((resolve) => this.#opened.push(resolve));
			this.#readers++;
		})();
	}

	/** Leaves a load phase `enter` began. */
	leave(): void {
		if (--this.#readers === 0) this.#drained?.();
	}

	/**
	 * Runs one operation in its turn (operations one at a time, in call order): `work` gets `exclusive`, which runs its
	 * argument once the load phases under way ended, with activations kept out until it returns; between exclusive
	 * sections activations load (an owner the operation activates). The waits end with `context`'s abort; the turn
	 * passes on.
	 */
	async turn<T>(
		work: (exclusive: <R>(section: () => Promise<R>) => Promise<R>) => Promise<T>,
		context: Context,
	): Promise<T> {
		const previous = this.#tail;
		const turn = Promise.withResolvers<void>();
		this.#tail = previous.then(() => turn.promise);
		try {
			await awaitWithContext(previous, context);
			return await work((section) => this.#exclusive(section, context));
		} finally {
			// Given up while waiting for its turn: the next one waits for the earlier ones still.
			void previous.then(turn.resolve);
		}
	}

	/** Runs `section` exclusively: activations wait from now on; the load phases under way are waited for first. */
	async #exclusive<R>(section: () => Promise<R>, context: Context): Promise<R> {
		this.#isExclusive = true;
		try {
			if (this.#readers > 0) {
				const drained = new Promise<void>((resolve) => {
					this.#drained = resolve;
				});
				await awaitWithContext(drained, context);
			}
			return await section();
		} finally {
			this.#isExclusive = false;
			this.#drained = undefined;
			for (const open of this.#opened.splice(0)) open();
		}
	}
}

/** What a host data operation needs of a live object. */
export type HostDataObject = {
	readonly identity: string;
	/** The object's type: the owner of its documents and tables in the store. */
	readonly owner: string;
	readonly documents: Documents;
	readonly liveQueries: LiveQueries;
	/** Its live attempt's declaration of table `table` (SQL name), if it has one. */
	declaredTable(table: string): TableDefinition | undefined;
};

/** What a host data operation needs of its host. */
export type HostDataSite = {
	readonly store: ChordStore;
	readonly batch: Batch;
	readonly gate: HostDataGate;
	/** The host's objects. */
	objects(): Iterable<HostDataObject>;
	/** Activates the served `local` type `owner` (empty params): its release; `undefined` when not served here. */
	activate(owner: string, context: Context): Promise<(() => void) | undefined>;
};

/**
 * Imports a host's data archive into the site's store under `options.address` or the archive's, coordinated with the
 * live owners (spec §5): read and checked; then, in the operation's turn and exclusively, against the catalog as the
 * load phases left it: the tables whose rows must migrate and their owners' histories. An owner not live for one is
 * activated (between exclusive sections) and the section runs again; with every history at hand, the commit with what
 * the owners hold of the address adopted. Owners activated for it are released when the operation ends, however.
 */
export async function importInto(
	site: HostDataSite,
	parts: AsyncIterable<unknown> | Iterable<unknown>,
	context: Context,
	options: HostImportOptions,
): Promise<HostDataCounts> {
	const archive = await readHostArchive(parts, context);
	const target =
		options.address === undefined ? archive.host : storedText(options.address.key, "importHostData: address");
	const existing = options.existing ?? "refuse";
	return site.gate.turn(async (exclusive) => {
		const activated = new Map<string, () => void>();
		try {
			for (;;) {
				const section = await exclusive(async (): Promise<ImportSection> => {
					const migrating = tablesToMigrate(site.store, archive);
					const histories = historiesOf([...site.objects()], migrating);
					const missing = migrating.filter((table) => !histories.has(table)).map(ownerOf);
					if (missing.length > 0) return { kind: "activate", owners: new Set(missing) };
					const owners = await hostDataOwners(site.store, target, archive, context);
					const plan = { target, existing, histories };
					const change = (commit: HostCommit) => importHostData(site.store, archive, plan, commit, context);
					return { kind: "done", counts: await coordinated(site, owners, target, context, change) };
				});
				if (section.kind === "done") return section.counts;
				for (const owner of section.owners) {
					// Activated once already, and still without a declaration of the table: it has none to migrate it.
					const release = activated.has(owner) ? undefined : await site.activate(owner, context);
					if (release === undefined) {
						throw invalid("args", `importHostData: ${owner} is not served here to migrate its tables`);
					}
					activated.set(owner, release);
				}
			}
		} finally {
			for (const release of activated.values()) release();
		}
	}, context);
}

/** One exclusive section of an import: owners to activate first, or the import done. */
type ImportSection =
	| { readonly kind: "activate"; readonly owners: ReadonlySet<string> }
	| { readonly kind: "done"; readonly counts: HostDataCounts };

/** The owner of table `table` (its SQL name `<owner>:<table>`). */
function ownerOf(table: string): string {
	return table.slice(0, table.indexOf(":"));
}

/** Deletes the data of `address` from the site's store, coordinated with the live owners (spec §5). */
export function deleteFrom(site: HostDataSite, address: Address, context: Context): Promise<HostDataCounts> {
	const key = storedText(address.key, "deleteHostData: address");
	const run = async (): Promise<HostDataCounts> => {
		const owners = await hostDataOwners(site.store, key, undefined, context);
		return coordinated(site, owners, key, context, (commit) => deleteHostData(site.store, key, commit, context));
	};
	return site.gate.turn((exclusive) => exclusive(run), context);
}

/** The live objects' declarations of `tables` (SQL names): the histories their rows migrate through. */
function historiesOf(objects: readonly HostDataObject[], tables: readonly string[]): Map<string, TableDefinition> {
	const histories = new Map<string, TableDefinition>();
	for (const table of tables) {
		for (const object of objects) {
			const definition = object.declaredTable(table);
			if (definition !== undefined) histories.set(table, definition);
		}
	}
	return histories;
}

/** A host-keyed slot's key a change reads again and adopts. */
type SlotRead = { readonly slot: KeyedSlot; changed: ChangedDocument };

/** A live query a change re-runs and adopts. */
type QueryRead = { readonly query: LiveQuery; run: Awaited<ReturnType<LiveQuery["rerun"]>> | undefined };

/**
 * Runs `change` (one commit changing the data of host `key`) holding the lines of the live objects of `owners` and of
 * those with persisted documents keyed by the key's kind, taken in identity order (cancellable). Inside the commit
 * step it reads what those objects hold of the key (resident and pinned documents, live queries over tables with a
 * host column of the kind); after `COMMIT` it adopts all of it in one host batch. The commit is admitted only while
 * `context` is not aborted (`released` otherwise, nothing written). A document an object cannot
 * read fails that object after the batch.
 */
async function coordinated<T>(
	site: HostDataSite,
	owners: ReadonlySet<string>,
	key: string,
	context: Context,
	change: (commit: HostCommit) => Promise<T>,
): Promise<T> {
	const kind = kindOfKey(key);
	const objects = [...site.objects()]
		.filter((object) => owners.has(object.owner) || object.documents.hostSlots(kind).length > 0)
		.sort((a, b) => (a.identity < b.identity ? -1 : 1));
	const releases: (() => void)[] = [];
	try {
		for (const object of objects) releases.push(await acquire(object.documents, context));
		const slots: SlotRead[] = objects.flatMap((object) =>
			object.documents
				.hostSlots(kind)
				.filter((slot) => slot.holds(key))
				.map((slot) => ({ slot, changed: { kind: "unchanged" } as ChangedDocument })),
		);
		const queries: QueryRead[] = objects.flatMap((object) =>
			object.liveQueries.onHostKind(kind).map((query) => ({ query, run: undefined })),
		);
		// Counted and adopted under the caller's telemetry; nothing after admission is cancelled by its signal.
		const quiet = withoutAbortSignal(context);
		const reads: StagedWrite = {
			order: "write",
			apply: async (step) => {
				for (const read of slots) read.changed = await read.slot.readChanged(key, step, quiet);
				for (const read of queries) read.run = await read.query.rerun(step, quiet);
				return [];
			},
		};
		const commit: HostCommit = {
			fence: {
				admit: () => context.abortSignal?.aborted !== true,
				adopt: () => {
					const failed: [KeyedSlot, ChordError][] = [];
					site.batch.commit(() => {
						for (const { slot, changed } of slots) {
							slot.adoptChanged(key, changed);
							if (changed.kind === "failed") failed.push([slot, changed.error]);
						}
						// Each read ran in the step before `COMMIT`.
						for (const { query, run } of queries) query.adopt(run!);
					}, quiet);
					// Outside the batch: failing an object ends its attempt, which publishes on its own.
					for (const [slot, error] of failed) slot.owner.fail(error);
				},
			},
			after: [reads],
		};
		return await change(commit);
	} finally {
		for (const release of releases) release();
	}
}

/** The line of `documents`, waited for until `context` aborts (an abandoned wait releases the line when it comes). */
async function acquire(documents: Documents, context: Context): Promise<() => void> {
	const acquiring = documents.line.acquire();
	try {
		return await awaitWithContext(acquiring, context);
	} catch (error) {
		void acquiring.then((release) => release());
		throw error;
	}
}
