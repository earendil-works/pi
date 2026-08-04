import { uuidv7 } from "@earendil-works/pi-ai";
import {
	type FileError,
	type Result,
	type SessionCreateOptions,
	SessionError,
	type SessionForkOptions,
	type SessionForkSelection,
	type SessionMetadata,
	type SessionTreeEntry,
} from "../types.ts";
import type { Session } from "./session.ts";

export function createSessionId(): string {
	return uuidv7();
}

export function createTimestamp(): string {
	return new Date().toISOString();
}

export interface SessionRepository<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
	TListOptions = void,
> extends AsyncDisposable {
	create(options: TCreateOptions): Promise<Session<TMetadata>>;
	open(metadata: TMetadata): Promise<Session<TMetadata>>;
	list(options?: TListOptions): Promise<TMetadata[]>;
	delete(metadata: TMetadata): Promise<void>;
	fork(source: TMetadata, options: SessionForkOptions & TCreateOptions): Promise<Session<TMetadata>>;
}

export function getFileSystemResultOrThrow<TValue>(result: Result<TValue, FileError>, message: string): TValue {
	if (!result.ok) {
		const code = result.error.code === "not_found" ? "not_found" : "storage";
		throw new SessionError(code, `${message}: ${result.error.message}`, result.error);
	}
	return result.value;
}

type MaybePromise<T> = T | Promise<T>;

interface SessionForkEntrySource {
	readEntry(id: string): MaybePromise<SessionTreeEntry | undefined>;
	readEntries(): MaybePromise<readonly SessionTreeEntry[]>;
	readPathToRootOrCompaction(leafId: string | null): MaybePromise<readonly SessionTreeEntry[]>;
}

/** @internal Transitional fork selection shared by built-in repositories. */
export function createSessionForkSelection(options: SessionForkOptions): SessionForkSelection {
	if (!options.entryId) return { kind: "all" };
	return (options.position ?? "before") === "at"
		? { kind: "through_entry", entryId: options.entryId }
		: { kind: "before_user_message", entryId: options.entryId };
}

/** @internal Shared fork selection validation for built-in repositories. */
export async function readSessionEntriesForFork(
	source: SessionForkEntrySource,
	selection: SessionForkSelection,
): Promise<readonly SessionTreeEntry[]> {
	if (selection.kind === "all") return source.readEntries();
	const target = await source.readEntry(selection.entryId);
	if (!target) throw new SessionError("invalid_fork_target", `Entry ${selection.entryId} not found`);
	if (selection.kind === "through_entry") return source.readPathToRootOrCompaction(target.id);
	if (target.type !== "message" || target.message.role !== "user") {
		throw new SessionError("invalid_fork_target", `Entry ${selection.entryId} is not a user message`);
	}
	return source.readPathToRootOrCompaction(target.parentId);
}
