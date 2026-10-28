import type { Context } from "@earendil-works/chord";
import {
	type ExecutionEnv,
	err,
	FileError,
	type FileKind,
	type FileListEntry,
	type FileListing,
	type ListFilesOptions,
	ok,
	type Result,
} from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { Connection } from "./connection.ts";
import { abortResult, toFileError } from "./errors.ts";

/** Kind bytes of `listFiles` records: `f`, `d`, `l`. */
const KINDS: Record<number, FileKind> = { 102: "file", 100: "directory", 108: "symlink" };

/**
 * `listFiles` of an absolute path through the daemon: fails with `not_supported` if the daemon does not list files
 * (a release before `listFiles`), so callers fall back to their own walk.
 */
export async function listFilesOver(
	connection: Connection,
	path: string,
	options: ListFilesOptions | undefined,
	context: Context,
): Promise<Result<FileListing, FileError>> {
	for (const key of ["maxEntries", "maxBytes", "timeoutMs"] as const) {
		const value = options?.[key];
		if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
			return err(new FileError("invalid", `${key} must be a non-negative safe integer`, path));
		}
	}
	const aborted = abortResult<FileListing>(context.abortSignal, path);
	if (aborted) return aborted;
	try {
		if (!(await connection.info()).features?.includes("listFiles")) {
			return err(new FileError("not_supported", "The pi-env daemon does not list files; update it", path));
		}
		const { json, payload } = await connection.request(
			"listFiles",
			// Fields left undefined are not sent; the daemon applies the defaults.
			{
				path,
				hidden: options?.hidden,
				gitignore: options?.gitignore,
				exclude: options?.exclude,
				maxEntries: options?.maxEntries,
				maxBytes: options?.maxBytes,
				timeoutMs: options?.timeoutMs,
			},
			context.abortSignal ? { signal: context.abortSignal } : {},
		);
		const afterAbort = abortResult<FileListing>(context.abortSignal, path);
		if (afterAbort) return afterAbort;
		// Records of a kind byte, the UTF-8 path, and a NUL.
		const entries: FileListEntry[] = [];
		const bytes = Buffer.from(payload.buffer, payload.byteOffset, payload.length);
		for (let start = 0; start < bytes.length; ) {
			const end = bytes.indexOf(0, start);
			if (end === -1) break;
			const kind = KINDS[bytes[start]!];
			if (kind !== undefined) entries.push({ path: bytes.toString("utf8", start + 1, end), kind });
			start = end + 1;
		}
		return ok({ entries, truncated: json.truncated === true });
	} catch (error) {
		return err(toFileError(error, path));
	}
}

export type LocalExecutionEnvOptions = ConstructorParameters<typeof NodeExecutionEnv>[0] & {
	/** A connection to this machine's daemon, `new Connection({ command: [localDaemon()] })`, for `listFiles`. */
	connection: Connection;
};

/**
 * `NodeExecutionEnv` with `listFiles` through a pi-env daemon on the same machine, so local and remote environments
 * list files with the same code. Everything else is `NodeExecutionEnv`'s. The connection belongs to the caller, who
 * closes it; several environments may share it.
 */
export class LocalExecutionEnv extends NodeExecutionEnv implements ExecutionEnv {
	readonly #connection: Connection;

	constructor(options: LocalExecutionEnvOptions) {
		const { connection, ...node } = options;
		super(node);
		this.#connection = connection;
	}

	async listFiles(
		path: string,
		options: ListFilesOptions | undefined,
		context: Context,
	): Promise<Result<FileListing, FileError>> {
		const resolved = await this.absolutePath(path, context);
		if (!resolved.ok) return resolved;
		return listFilesOver(this.#connection, resolved.value, options, context);
	}
}
