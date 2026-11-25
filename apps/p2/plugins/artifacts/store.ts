// Artifacts in the server's store (decision "Artifacts and views", apps/p3/docs/decisions.md): data belonging to the
// session's host address, so a session's export, import and delete carry it. Per session two documents keyed by the
// session (`keyed: Session`): its artifacts (kind, title, newest version, times) and its html pages' states; each
// version's content a row of a table with a `host(Session)` column, written once. Every write is one transaction of the
// server's `ArtifactStoreHost`; the reads before a write run inside it.
import { int, map, num, obj, oneOf, str, unknown } from "@earendil-works/pi-schema";
import {
	type Address,
	type Context,
	columnInt,
	columnStr,
	defineState,
	defineTable,
	hostColumn,
	type JsonValue,
	type KeyedHandle,
	Session,
	type TableOf,
	type Tx,
	unsafe,
} from "@p2/app/v1";
import {
	ARTIFACT_ID,
	type ArtifactKind,
	type ArtifactSummary,
	MAX_ARTIFACT_BYTES,
	MAX_ARTIFACT_STATE,
} from "./contract.ts";

/** One artifact as a session's document keeps it. */
const StoredSchema = obj({
	kind: oneOf(["html", "md"] as const),
	title: str(),
	version: int({ minimum: 1 }),
	updated: num(),
	created: num(),
});
type Stored = { kind: ArtifactKind; title: string; version: number; updated: number; created: number };

/** A session's artifacts, by ID. */
export const ArtifactsSchema = obj({ artifacts: map(StoredSchema) });
export type ArtifactsDoc = { artifacts: Record<string, Stored> };

/** A session's html pages' states, by artifact ID. */
export const StatesSchema = obj({ states: map(unsafe<JsonValue>(unknown())) });
export type StatesDoc = { states: Record<string, JsonValue> };

/** Each session's artifacts (persisted: they show while the session's worker is stopped). */
export const ArtifactsState = defineState("p2.artifacts", {
	schema: ArtifactsSchema,
	version: 1,
	initial: (): ArtifactsDoc => ({ artifacts: {} }),
	keyed: Session,
	persist: true,
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 32,
});

/** Each session's html pages' states (a state replaces the whole value: a delta is as large as a base). */
export const StatesState = defineState("p2.artifact-states", {
	schema: StatesSchema,
	version: 1,
	initial: (): StatesDoc => ({ states: {} }),
	keyed: Session,
	persist: true,
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 8,
});

/** Each version's content, never changed once written. */
export const VersionRows = defineTable("artifact_versions", {
	version: 1,
	columns: { session: hostColumn(Session), id: columnStr(), version: columnInt(), content: columnStr() },
	key: ["session", "id", "version"],
});

/** The documents and table, and the transactions of the object that writes them. */
export type ArtifactTables = {
	readonly artifacts: KeyedHandle<ArtifactsDoc, Address<typeof Session>>;
	readonly states: KeyedHandle<StatesDoc, Address<typeof Session>>;
	readonly versions: TableOf<typeof VersionRows>;
	readonly tx: <R>(fn: (tx: Tx) => R | Promise<R>, context: Context) => Promise<R>;
};

/** A session's artifacts as lists show them, the newest first. */
export const summariesOf = (doc: Readonly<ArtifactsDoc>): ArtifactSummary[] =>
	Object.entries(doc.artifacts)
		.map(([id, stored]) => summaryOf(id, stored))
		.sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id));

/** One stored artifact as lists show it. */
export const summaryOf = (id: string, stored: Readonly<Stored>): ArtifactSummary => ({
	id,
	kind: stored.kind,
	title: stored.title,
	version: stored.version,
	updated: stored.updated,
});

/** Every session's artifacts, read and written. */
export class ArtifactStore {
	readonly #t: ArtifactTables;

	constructor(tables: ArtifactTables) {
		this.#t = tables;
	}

	/** Version `version` (default the newest) of artifact `id`'s content, with its summary. */
	async read(
		session: string,
		id: string,
		version: number | undefined,
		context: Context,
	): Promise<{ summary: ArtifactSummary; version: number; content: string }> {
		const address = Session({ id: session });
		const stored = (await this.#t.artifacts.get(address, context))?.artifacts[id];
		if (!stored) throw new Error(`No artifact "${id}"`);
		const wanted = version ?? stored.version;
		const row = await this.#t.versions.get({ session: address, id, version: wanted }, context);
		if (!row) throw new Error(`Artifact "${id}" has no version ${wanted} (its newest is ${stored.version})`);
		return { summary: summaryOf(id, stored), version: wanted, content: row.content };
	}

	/**
	 * Writes a new artifact (its ID made from `title` when not given, numbered when taken) or the next version of artifact
	 * `id` (of the same kind).
	 */
	write(
		session: string,
		input: { id?: string; kind: ArtifactKind; title: string; content: string },
		now: number,
		context: Context,
	): Promise<{ id: string; version: number }> {
		checkContent(input.content);
		const address = Session({ id: session });
		return this.#t.tx(async (tx) => {
			const doc = await tx.draft(this.#t.artifacts, address);
			const id = input.id ?? freeId(doc.artifacts, input.title);
			const stored = doc.artifacts[id];
			if (stored && stored.kind !== input.kind)
				throw new Error(`Artifact "${id}" is ${stored.kind}, not ${input.kind}`);
			const version = (stored?.version ?? 0) + 1;
			doc.artifacts[id] = {
				kind: input.kind,
				title: input.title,
				version,
				updated: now,
				created: stored?.created ?? now,
			};
			tx.put(this.#t.versions, { session: address, id, version, content: input.content });
			return { id, version };
		}, context);
	}

	/** Writes the next version of artifact `id` with `edits` applied to its newest content (each `old` once). */
	edit(
		session: string,
		id: string,
		edits: readonly { readonly old: string; readonly new: string }[],
		now: number,
		context: Context,
	): Promise<{ version: number }> {
		const address = Session({ id: session });
		return this.#t.tx(async (tx) => {
			const doc = await tx.draft(this.#t.artifacts, address);
			const stored = doc.artifacts[id];
			if (!stored) throw new Error(`No artifact "${id}"`);
			const current = await tx.get(this.#t.versions, { session: address, id, version: stored.version });
			if (!current) throw new Error(`Artifact "${id}" lost its version ${stored.version}`);
			const content = applyEdits(current.content, edits);
			checkContent(content);
			const version = stored.version + 1;
			stored.version = version;
			stored.updated = now;
			tx.put(this.#t.versions, { session: address, id, version, content });
			return { version };
		}, context);
	}

	/** Removes artifact `id` with its versions and state. */
	remove(session: string, id: string, context: Context): Promise<void> {
		const address = Session({ id: session });
		return this.#t.tx(async (tx) => {
			const doc = await tx.draft(this.#t.artifacts, address);
			const stored = doc.artifacts[id];
			if (!stored) throw new Error(`No artifact "${id}"`);
			for (let version = 1; version <= stored.version; version++)
				tx.delete(this.#t.versions, { session: address, id, version });
			delete doc.artifacts[id];
			const states = await tx.draft(this.#t.states, address);
			delete states.states[id];
		}, context);
	}

	/** Copies session `from`'s artifacts, every version, and states to session `to` (a clone or fork; it has none yet). */
	copy(from: string, to: string, context: Context): Promise<void> {
		const source = Session({ id: from });
		const target = Session({ id: to });
		return this.#t.tx(async (tx) => {
			const artifacts = await tx.draft(this.#t.artifacts, source);
			const states = await tx.draft(this.#t.states, source);
			const copied = await tx.draft(this.#t.artifacts, target);
			for (const [id, stored] of Object.entries(artifacts.artifacts)) {
				for (let version = 1; version <= stored.version; version++) {
					const row = await tx.get(this.#t.versions, { session: source, id, version });
					if (row) tx.put(this.#t.versions, { ...row, session: target });
				}
				copied.artifacts[id] = { ...stored };
			}
			const copiedStates = await tx.draft(this.#t.states, target);
			for (const [id, state] of Object.entries(states.states)) copiedStates.states[id] = state;
		}, context);
	}

	/** Html artifact `id`'s state (null until something set it). */
	async state(session: string, id: string, context: Context): Promise<JsonValue> {
		const address = Session({ id: session });
		const stored = (await this.#t.artifacts.get(address, context))?.artifacts[id];
		if (!stored) throw new Error(`No artifact "${id}"`);
		if (stored.kind !== "html") throw new Error(`Artifact "${id}" is ${stored.kind}: only html pages have a state`);
		return (await this.#t.states.get(address, context))?.states[id] ?? null;
	}

	/** Sets html artifact `id`'s state (any JSON, at most `MAX_ARTIFACT_STATE`). */
	setState(session: string, id: string, state: JsonValue, context: Context): Promise<void> {
		const size = JSON.stringify(state ?? null).length;
		if (size > MAX_ARTIFACT_STATE)
			throw new Error(`The state is ${size} characters of JSON; at most ${MAX_ARTIFACT_STATE}`);
		const address = Session({ id: session });
		return this.#t.tx(async (tx) => {
			const stored = (await tx.draft(this.#t.artifacts, address)).artifacts[id];
			if (!stored) throw new Error(`No artifact "${id}"`);
			if (stored.kind !== "html")
				throw new Error(`Artifact "${id}" is ${stored.kind}: only html pages have a state`);
			(await tx.draft(this.#t.states, address)).states[id] = state ?? null;
		}, context);
	}
}

/** A free ID made from `title`: its slug, numbered when taken. */
function freeId(taken: Readonly<Record<string, unknown>>, title: string): string {
	const slug =
		title
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "artifact";
	const base = ARTIFACT_ID.test(slug) ? slug : `a-${slug}`.slice(0, 48);
	if (!Object.hasOwn(taken, base)) return base;
	for (let n = 2; ; n++) if (!Object.hasOwn(taken, `${base}-${n}`)) return `${base}-${n}`;
}

/** Content within bounds: well-formed text of at most `MAX_ARTIFACT_BYTES` of UTF-8. */
function checkContent(content: string): void {
	if (!content.isWellFormed()) throw new Error("The content is not well-formed text");
	if (Buffer.byteLength(content, "utf8") > MAX_ARTIFACT_BYTES) throw new Error("The content exceeds 2 MiB");
}

/**
 * `edits` applied to `text`: each `old` must occur exactly once in the text as it is, and no two may overlap; all or
 * nothing.
 */
export function applyEdits(text: string, edits: readonly { readonly old: string; readonly new: string }[]): string {
	const ranges = edits.map((edit, index) => {
		const at = text.indexOf(edit.old);
		if (at < 0) throw new Error(`edits[${index}]: old text not found`);
		if (text.indexOf(edit.old, at + 1) >= 0)
			throw new Error(`edits[${index}]: old text occurs more than once; include more context`);
		return { start: at, end: at + edit.old.length, text: edit.new };
	});
	ranges.sort((a, b) => a.start - b.start);
	for (let index = 1; index < ranges.length; index++)
		if ((ranges[index]?.start ?? 0) < (ranges[index - 1]?.end ?? 0))
			throw new Error("Two edits overlap; merge them into one");
	let next = text;
	for (const range of ranges.toReversed()) next = next.slice(0, range.start) + range.text + next.slice(range.end);
	return next;
}
