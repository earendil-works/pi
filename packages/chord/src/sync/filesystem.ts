import type { Context } from "../context/index.ts";
import type { SyncBody } from "./batch.ts";
import { isNotFound, type SyncFileReader, type SyncFileSystem, unwrap } from "./files.ts";
import {
	type BatchInfo,
	type JsonObject,
	LOG_START,
	type PutBatchResult,
	type RemoteListing,
	type Seq,
	type SessionChanges,
	type SessionSyncMaintenance,
} from "./remote.ts";

const pad = (value: number): string => String(value).padStart(16, "0");
/** How much of a body is read from its file at a time. */
const READ_CHUNK = 256 * 1024;

/** One buffer as a body. */
async function* once(bytes: Uint8Array): SyncBody {
	yield bytes;
}
const SLOT_NAME = /^(\d{16})\.json$/;
const SNAPSHOT_NAME = /^(\d{16})\.batch$/;
const SESSION_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** A session ID names a file or directory: refuse anything that could leave the root. */
export function checkSessionId(sessionId: string): string {
	if (!SESSION_ID.test(sessionId)) throw new Error(`Invalid session ID for a sync directory: ${sessionId}`);
	return sessionId;
}

/**
 * A remote store in a directory, laid out as the real remote is: per session, one slot per batch start, holding where
 * the batch ends and which device created it, and snapshots named by their end. As the real remote, it creates a slot
 * only where the history ends.
 *
 * One process writes a directory, through one instance: creating a slot is a check, then a write, queued per session
 * in this instance, so two uploads of a session cannot both create a slot. Across processes nothing guards it (the
 * file operations have no exclusive create): an app with several processes routes their uploads through one.
 *
 * Every file is flushed to disk before it is renamed into place, so a slot that exists survives a power loss with its
 * body. The head of a session's history is kept in a file, written after each slot, so creating one reads a few files,
 * not every slot.
 *
 * ```text
 * {root}/{session}/slots/{after}.json     { after, to, device, archive?, folded? }, written once
 * {root}/{session}/batches/{after}.batch  the commits (or an archive), until folded
 * {root}/{session}/snapshots/{to}.batch   a store archive
 * {root}/{session}/head.json             { head }: where the history ends, or a little before it
 * {root}/{session}/meta.json             the host's description, last write wins
 * ```
 */
export class FileSystemSyncRemote implements SessionSyncMaintenance {
	readonly #fs: SyncFileSystem;
	readonly #root: string;
	/** Each session's slot creation under way, so the next waits for it: the last one queued, by session. */
	readonly #creating = new Map<string, Promise<unknown>>();

	constructor(fs: SyncFileSystem, root: string) {
		this.#fs = fs;
		this.#root = root;
	}

	putBatch(
		sessionId: string,
		after: Seq,
		to: Seq,
		device: string,
		body: SyncBody,
		context: Context,
		options: { readonly archive?: boolean } = {},
	): Promise<PutBatchResult> {
		const previous = this.#creating.get(sessionId) ?? Promise.resolve();
		const run = previous.then(() => this.#create(sessionId, after, to, device, body, context, options));
		const settled = run.catch(() => {});
		this.#creating.set(sessionId, settled);
		void settled.then(() => {
			if (this.#creating.get(sessionId) === settled) this.#creating.delete(sessionId);
		});
		return run;
	}

	/** `putBatch` once no other slot of the session is being created. */
	async #create(
		sessionId: string,
		after: Seq,
		to: Seq,
		device: string,
		body: SyncBody,
		context: Context,
		options: { readonly archive?: boolean },
	): Promise<PutBatchResult> {
		const existing = await this.#slot(sessionId, after, context);
		if (existing !== undefined) return { type: "exists", to: existing.to, device: existing.device };
		const head = await this.#head(sessionId, context);
		if (after !== head) return { type: "not_head", head };
		await this.#write(sessionId, ["batches"], `${pad(after)}.batch`, body, context);
		// The slot is written last: it is what makes the batch exist.
		const slot: BatchInfo = { after, to, device, ...(options.archive === true ? { archive: true as const } : {}) };
		await this.#write(
			sessionId,
			["slots"],
			`${pad(after)}.json`,
			once(new TextEncoder().encode(JSON.stringify(slot))),
			context,
		);
		await this.#write(
			sessionId,
			[],
			"head.json",
			once(new TextEncoder().encode(JSON.stringify({ head: to }))),
			context,
		);
		return { type: "created" };
	}

	/**
	 * Where the session's history ends: the head file, then the chain of slots after it. A crash between a slot and the
	 * head file leaves the file behind by that slot; a directory written before head files walks the chain once.
	 */
	async #head(sessionId: string, context: Context): Promise<Seq> {
		const bytes = await this.#read(context, sessionId, "head.json");
		let at = bytes === undefined ? LOG_START : (JSON.parse(new TextDecoder().decode(bytes)) as { head: Seq }).head;
		for (let next = await this.#slot(sessionId, at, context); next !== undefined; ) {
			at = next.to;
			next = await this.#slot(sessionId, at, context);
		}
		return at;
	}

	async getBatch(sessionId: string, after: Seq, context: Context): Promise<SyncBody | undefined> {
		const slot = await this.#slot(sessionId, after, context);
		if (slot === undefined || slot.folded) return undefined;
		return this.#stream(context, sessionId, "batches", `${pad(after)}.batch`);
	}

	getSnapshot(sessionId: string, to: Seq, context: Context): Promise<SyncBody | undefined> {
		return this.#stream(context, sessionId, "snapshots", `${pad(to)}.batch`);
	}

	async putSnapshot(sessionId: string, to: Seq, body: SyncBody, context: Context): Promise<void> {
		await this.#write(sessionId, ["snapshots"], `${pad(to)}.batch`, body, context);
	}

	async foldBatches(sessionId: string, afters: readonly Seq[], context: Context): Promise<void> {
		for (const after of afters) {
			const slot = await this.#slot(sessionId, after, context);
			if (slot === undefined || slot.folded) continue;
			const folded: BatchInfo = { ...slot, folded: true };
			await this.#write(
				sessionId,
				["slots"],
				`${pad(after)}.json`,
				once(new TextEncoder().encode(JSON.stringify(folded))),
				context,
			);
			const body = await this.#path(context, sessionId, "batches", `${pad(after)}.batch`);
			unwrap(await this.#fs.remove(body, { force: true }, context));
		}
	}

	async deleteSnapshots(sessionId: string, snapshots: readonly Seq[], context: Context): Promise<void> {
		for (const to of snapshots) {
			const path = await this.#path(context, sessionId, "snapshots", `${pad(to)}.batch`);
			unwrap(await this.#fs.remove(path, { force: true }, context));
		}
	}

	async list(sessionId: string, context: Context): Promise<RemoteListing> {
		const batches: BatchInfo[] = [];
		for (const name of await this.#names(context, sessionId, "slots")) {
			const match = SLOT_NAME.exec(name);
			if (match === null) continue;
			const slot = await this.#slot(sessionId, Number(match[1]), context);
			if (slot !== undefined) batches.push(slot);
		}
		const snapshots: Seq[] = [];
		for (const name of await this.#names(context, sessionId, "snapshots")) {
			const match = SNAPSHOT_NAME.exec(name);
			if (match !== null) snapshots.push(Number(match[1]));
		}
		return { batches, snapshots };
	}

	/** Every session, every time: a directory keeps no change order. */
	async sessions(_cursor: string | undefined, context: Context): Promise<SessionChanges> {
		const result = await this.#fs.listDir(this.#root, context);
		const names = isNotFound(result)
			? []
			: unwrap(result)
					.filter((info) => info.kind === "directory" && SESSION_ID.test(info.name))
					.map((info) => info.name)
					.sort();
		const sessions = [];
		for (const id of names) {
			sessions.push({
				id,
				head: await this.#head(id, context),
				meta: await this.getMeta(id, context),
			});
		}
		return { sessions, cursor: "", more: false };
	}

	async putMeta(sessionId: string, meta: JsonObject, context: Context): Promise<void> {
		await this.#write(sessionId, [], "meta.json", once(new TextEncoder().encode(JSON.stringify(meta))), context);
	}

	async getMeta(sessionId: string, context: Context): Promise<JsonObject | undefined> {
		const bytes = await this.#read(context, sessionId, "meta.json");
		return bytes === undefined ? undefined : (JSON.parse(new TextDecoder().decode(bytes)) as JsonObject);
	}

	async #slot(sessionId: string, after: Seq, context: Context): Promise<BatchInfo | undefined> {
		const bytes = await this.#read(context, sessionId, "slots", `${pad(after)}.json`);
		return bytes === undefined ? undefined : (JSON.parse(new TextDecoder().decode(bytes)) as BatchInfo);
	}

	async #names(context: Context, sessionId: string, ...parts: string[]): Promise<string[]> {
		const result = await this.#fs.listDir(await this.#path(context, sessionId, ...parts), context);
		if (isNotFound(result)) return [];
		return unwrap(result).map((info) => info.name);
	}

	async #read(context: Context, sessionId: string, ...parts: string[]): Promise<Uint8Array | undefined> {
		const result = await this.#fs.readBinaryFile(await this.#path(context, sessionId, ...parts), context);
		if (isNotFound(result)) return undefined;
		return unwrap(result);
	}

	/** A body streamed back from its file, a chunk at a time; undefined when the file is missing. */
	async #stream(context: Context, sessionId: string, ...parts: string[]): Promise<SyncBody | undefined> {
		const opened = await this.#fs.openBinaryReader(
			await this.#path(context, sessionId, ...parts),
			undefined,
			context,
		);
		if (isNotFound(opened)) return undefined;
		return readerBody(unwrap(opened), context);
	}

	/**
	 * Write a body through a temporary file, flushed to disk, and a rename, so a reader never sees half a file and a
	 * renamed file keeps its content after a power loss; the body is appended chunk by chunk as it streams.
	 */
	async #write(
		sessionId: string,
		directory: readonly string[],
		name: string,
		body: SyncBody,
		context: Context,
	): Promise<void> {
		unwrap(
			await this.#fs.createDir(await this.#path(context, sessionId, ...directory), { recursive: true }, context),
		);
		const path = await this.#path(context, sessionId, ...directory, name);
		const temporary = await this.#path(context, sessionId, ...directory, `${name}.tmp`);
		unwrap(await this.#fs.writeFile(temporary, new Uint8Array(), context));
		try {
			for await (const chunk of body) unwrap(await this.#fs.appendFile(temporary, chunk, context));
			unwrap(await this.#fs.flushFile(temporary, context));
		} catch (error) {
			await this.#fs.remove(temporary, { force: true }, context);
			throw error;
		}
		unwrap(await this.#fs.renameFile(temporary, path, context));
	}

	async #path(context: Context, sessionId: string, ...parts: string[]): Promise<string> {
		return unwrap(await this.#fs.joinPath([this.#root, checkSessionId(sessionId), ...parts], context));
	}
}

/**
 * An open file as a body, a chunk at a time, closed at its end, on a failed read, or on `return()`. Not an async
 * generator: its `finally` runs only once started, and a file left to garbage collection is an uncaught error on Node 26.
 */
function readerBody(reader: SyncFileReader, context: Context): SyncBody {
	let offset = 0;
	let closing: Promise<void> | undefined;
	const close = async (): Promise<IteratorReturnResult<undefined>> => {
		closing ??= reader.close(context);
		await closing;
		return { done: true, value: undefined };
	};
	const body: AsyncIterableIterator<Uint8Array, undefined> = {
		async next() {
			if (closing !== undefined) return close();
			let chunk: Uint8Array;
			try {
				chunk = unwrap(await reader.read(offset, READ_CHUNK, context));
			} catch (error) {
				await close();
				throw error;
			}
			if (chunk.length === 0) return close();
			offset += chunk.length;
			return { done: false, value: chunk };
		},
		return: close,
		[Symbol.asyncIterator]: () => body,
	};
	return body;
}
