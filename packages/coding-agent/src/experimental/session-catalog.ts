import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** One server-hosted Session: a directory holding `meta.json` and the worker-owned `session.sqlite`. */
export interface SessionCatalogMetadata {
	readonly id: string;
	readonly createdAt: number;
	/** The working directory the Session's agent runs in. */
	readonly cwd: string;
	/** The Session directory. Workers lock it and own the storage inside it. */
	readonly path: string;
}

const METADATA_FILE = "meta.json";
const STORAGE_FILE = "session.sqlite";
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSessionId(id: string): boolean {
	return SESSION_ID.test(id);
}

/** The durable storage file of a Session. Only the Session's worker opens it. */
export function sessionStoragePath(metadata: SessionCatalogMetadata): string {
	return join(metadata.path, STORAGE_FILE);
}

/** Every Session in the directory. Entries without valid metadata are skipped. */
export async function listSessions(sessionDir: string): Promise<SessionCatalogMetadata[]> {
	let names: string[];
	try {
		names = await readdir(sessionDir);
	} catch (error) {
		if (isNotFound(error)) return [];
		throw error;
	}
	const sessions = await Promise.all(names.filter(isSessionId).map((name) => readSession(sessionDir, name)));
	return sessions.filter((metadata) => metadata !== undefined);
}

/** One Session by ID, or undefined when it does not exist. */
export async function readSession(sessionDir: string, id: string): Promise<SessionCatalogMetadata | undefined> {
	if (!isSessionId(id)) return undefined;
	const path = join(sessionDir, id);
	let value: unknown;
	try {
		value = JSON.parse(await readFile(join(path, METADATA_FILE), "utf8"));
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const { createdAt, cwd } = value as { createdAt?: unknown; cwd?: unknown };
	if (typeof createdAt !== "number" || typeof cwd !== "string") return undefined;
	return { id, createdAt, cwd, path };
}

/** Create an empty Session. Its worker creates the storage on first open. */
export async function createSession(
	sessionDir: string,
	options: { readonly id?: string; readonly cwd: string },
): Promise<SessionCatalogMetadata> {
	const id = options.id ?? randomUUID();
	if (!isSessionId(id)) throw new Error(`Invalid session ID: ${id}`);
	const path = join(sessionDir, id);
	await mkdir(sessionDir, { recursive: true });
	try {
		await mkdir(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Session ${id} already exists`);
		throw error;
	}
	const metadata: SessionCatalogMetadata = { id, createdAt: Date.now(), cwd: options.cwd, path };
	await writeFile(
		join(path, METADATA_FILE),
		`${JSON.stringify({ createdAt: metadata.createdAt, cwd: metadata.cwd }, null, "\t")}\n`,
	);
	return metadata;
}

/** Delete a Session directory. Its worker must be closed first. */
export async function deleteSession(metadata: SessionCatalogMetadata): Promise<void> {
	await rm(metadata.path, { recursive: true, force: true });
}

function isNotFound(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
