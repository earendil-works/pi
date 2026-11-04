// A sync remote in a local directory, for development and tests (Node).

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../../context/index.ts";
import {
	type BatchInfo,
	type JsonObject,
	type PutBatchResult,
	type RemoteListing,
	remoteHead,
	type Seq,
	type SessionChanges,
	type SessionSyncMaintenance,
} from "../remote.ts";

const pad = (value: number): string => String(value).padStart(16, "0");
const SLOT_NAME = /^(\d{16})\.json$/;
const SNAPSHOT_NAME = /^(\d{16})\.batch$/;
const SESSION_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** A session ID names a file or directory: refuse anything that could leave the root. */
export function checkSessionId(sessionId: string): string {
	if (!SESSION_ID.test(sessionId)) throw new Error(`Invalid session ID for a sync directory: ${sessionId}`);
	return sessionId;
}

/** Whether `error` is a missing file or directory. */
export function isNotFound(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** Write through a temporary file and a rename, so a reader never sees half a file. */
export async function writeAtomically(directory: string, name: string, body: Uint8Array | string): Promise<void> {
	await mkdir(directory, { recursive: true });
	const temporary = join(directory, `${name}.tmp`);
	await writeFile(temporary, body);
	await rename(temporary, join(directory, name));
}

/**
 * A remote store in a directory, laid out as the real remote is: per session, one slot per batch start, holding where
 * the batch ends and which device created it, and snapshots named by their end. As the real remote, it creates a slot
 * only where the history ends. Creating a slot is check-then-write, without the atomicity of the real remote across
 * processes: for development and tests, with one process writing.
 *
 * ```text
 * {root}/{session}/slots/{after}.json     { after, to, device, archive?, folded? }, written once
 * {root}/{session}/batches/{after}.batch  the commits (or an archive), until folded
 * {root}/{session}/snapshots/{to}.batch   a store archive
 * {root}/{session}/meta.json              the host's description, last write wins
 * ```
 */
export class FileSystemSyncRemote implements SessionSyncMaintenance {
	readonly #root: string;

	constructor(root: string) {
		this.#root = root;
	}

	async putBatch(
		sessionId: string,
		after: Seq,
		to: Seq,
		device: string,
		body: Uint8Array,
		context: Context,
		options: { readonly archive?: boolean } = {},
	): Promise<PutBatchResult> {
		const existing = await this.#slot(sessionId, after);
		if (existing !== undefined) return { type: "exists", to: existing.to, device: existing.device };
		const head = remoteHead(await this.list(sessionId, context));
		if (after !== head) return { type: "not_head", head };
		await writeAtomically(this.#path(sessionId, "batches"), `${pad(after)}.batch`, body);
		// The slot is written last: it is what makes the batch exist.
		const slot: BatchInfo = { after, to, device, ...(options.archive === true ? { archive: true as const } : {}) };
		await writeAtomically(this.#path(sessionId, "slots"), `${pad(after)}.json`, JSON.stringify(slot));
		return { type: "created" };
	}

	async getBatch(sessionId: string, after: Seq, _context: Context): Promise<Uint8Array | undefined> {
		const slot = await this.#slot(sessionId, after);
		if (slot === undefined || slot.folded) return undefined;
		return this.#read(this.#path(sessionId, "batches", `${pad(after)}.batch`));
	}

	getSnapshot(sessionId: string, to: Seq, _context: Context): Promise<Uint8Array | undefined> {
		return this.#read(this.#path(sessionId, "snapshots", `${pad(to)}.batch`));
	}

	async putSnapshot(sessionId: string, to: Seq, body: Uint8Array, _context: Context): Promise<void> {
		await writeAtomically(this.#path(sessionId, "snapshots"), `${pad(to)}.batch`, body);
	}

	async foldBatches(sessionId: string, afters: readonly Seq[], _context: Context): Promise<void> {
		for (const after of afters) {
			const slot = await this.#slot(sessionId, after);
			if (slot === undefined || slot.folded) continue;
			const folded: BatchInfo = { ...slot, folded: true };
			await writeAtomically(this.#path(sessionId, "slots"), `${pad(after)}.json`, JSON.stringify(folded));
			await rm(this.#path(sessionId, "batches", `${pad(after)}.batch`), { force: true });
		}
	}

	async deleteSnapshots(sessionId: string, snapshots: readonly Seq[], _context: Context): Promise<void> {
		for (const to of snapshots) await rm(this.#path(sessionId, "snapshots", `${pad(to)}.batch`), { force: true });
	}

	async list(sessionId: string, _context: Context): Promise<RemoteListing> {
		const batches: BatchInfo[] = [];
		for (const name of await this.#names(this.#path(sessionId, "slots"))) {
			const match = SLOT_NAME.exec(name);
			if (match === null) continue;
			const slot = await this.#slot(sessionId, Number(match[1]));
			if (slot !== undefined) batches.push(slot);
		}
		const snapshots: Seq[] = [];
		for (const name of await this.#names(this.#path(sessionId, "snapshots"))) {
			const match = SNAPSHOT_NAME.exec(name);
			if (match !== null) snapshots.push(Number(match[1]));
		}
		return { batches, snapshots };
	}

	/** Every session, every time: a directory keeps no change order. */
	async sessions(_cursor: string | undefined, context: Context): Promise<SessionChanges> {
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(this.#root, { withFileTypes: true });
		} catch (error) {
			if (!isNotFound(error)) throw error;
			entries = [];
		}
		const names = entries
			.filter((entry) => entry.isDirectory() && SESSION_ID.test(entry.name))
			.map((entry) => entry.name)
			.sort();
		const sessions = [];
		for (const id of names) {
			sessions.push({ id, head: remoteHead(await this.list(id, context)), meta: await this.getMeta(id, context) });
		}
		return { sessions, cursor: "", more: false };
	}

	async putMeta(sessionId: string, meta: JsonObject, _context: Context): Promise<void> {
		await writeAtomically(this.#path(sessionId), "meta.json", JSON.stringify(meta));
	}

	async getMeta(sessionId: string, _context: Context): Promise<JsonObject | undefined> {
		const bytes = await this.#read(this.#path(sessionId, "meta.json"));
		return bytes === undefined ? undefined : (JSON.parse(new TextDecoder().decode(bytes)) as JsonObject);
	}

	async #slot(sessionId: string, after: Seq): Promise<BatchInfo | undefined> {
		const bytes = await this.#read(this.#path(sessionId, "slots", `${pad(after)}.json`));
		return bytes === undefined ? undefined : (JSON.parse(new TextDecoder().decode(bytes)) as BatchInfo);
	}

	async #names(directory: string): Promise<string[]> {
		try {
			return await readdir(directory);
		} catch (error) {
			if (isNotFound(error)) return [];
			throw error;
		}
	}

	async #read(path: string): Promise<Uint8Array | undefined> {
		try {
			return new Uint8Array(await readFile(path));
		} catch (error) {
			if (isNotFound(error)) return undefined;
			throw error;
		}
	}

	#path(sessionId: string, ...parts: string[]): string {
		return join(this.#root, checkSessionId(sessionId), ...parts);
	}
}
