import type { FileSystem } from "../../types.ts";
import type { JsonValue, SessionCreateOptions, SessionMetadata } from "../types.ts";

export type JsonlSessionRepoFileSystem = Pick<
	FileSystem,
	| "absolutePath"
	| "joinPath"
	| "readTextFile"
	| "readTextLines"
	| "writeFile"
	| "appendFile"
	| "renameFile"
	| "fileInfo"
	| "listDir"
	| "exists"
	| "createDir"
	| "remove"
>;

export interface JsonlSessionRepoOptions {
	fs: JsonlSessionRepoFileSystem;
	/** Root containing coding-agent-compatible cwd-encoded session directories. */
	sessionsRoot: string;
}

export interface JsonlSessionMetadata extends SessionMetadata {
	cwd: string;
	path: string;
	/** Filesystem modification time as milliseconds since Unix epoch. */
	modifiedAt: number;
	sourceFormat: 3 | 4;
	/** Present only when a v3 parent path could not be resolved to a session id. */
	legacyParentSessionPath?: string;
	/** Opaque application-owned metadata. */
	metadata?: Record<string, JsonValue>;
}

export interface JsonlSessionCreateOptions extends SessionCreateOptions {
	cwd: string;
	metadata?: Record<string, JsonValue>;
}

export interface JsonlSessionListOptions {
	cwd?: string;
}

export interface JsonlV4Header {
	kind: "header";
	version: 4;
	id: string;
	createdAt: number;
	cwd: string;
	parentSessionId?: string;
	/** Preserved only when a v3 parent path could not be resolved to a session id. */
	legacyParentSessionPath?: string;
	metadata?: Record<string, JsonValue>;
}
