import { err, FileError, type Result } from "@earendil-works/pi-durable/env";
import { RemoteError } from "./connection.ts";

export function abortResult<T>(signal: AbortSignal | undefined, path?: string): Result<T, FileError> | undefined {
	return signal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
}

/** `NodeExecutionEnv`'s mapping of Node error codes to `FileError` codes. */
export function toFileError(error: unknown, fallbackPath?: string): FileError {
	if (error instanceof FileError) return error;
	if (!(error instanceof RemoteError)) {
		const cause = error instanceof Error ? error : new Error(String(error));
		return new FileError("unknown", cause.message, fallbackPath, cause);
	}
	const path = error.path ?? fallbackPath;
	switch (error.code) {
		case "aborted":
			return new FileError("aborted", error.message, path, error);
		case "ENOENT":
			return new FileError("not_found", error.message, path, error);
		case "EACCES":
		case "EPERM":
			return new FileError("permission_denied", error.message, path, error);
		case "ENOTDIR":
			return new FileError("not_directory", error.message, path, error);
		case "EISDIR":
			return new FileError("is_directory", error.message, path, error);
		case "EINVAL":
		case "SYMLINK":
		case "NOT_REGULAR":
			return new FileError("invalid", error.message, path, error);
	}
	return new FileError("unknown", error.message, path, error);
}
