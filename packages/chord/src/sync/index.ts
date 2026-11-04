// Session sync over a store's outbox (`@earendil-works/chord/sync`, experimental). Portable: the remote and the host's
// sync state are interfaces, and the directory-backed ones take their file operations (`SyncFileSystem`).

export { decodeBatch, decodeSnapshot, encodeBatch, encodeSnapshot } from "./batch.ts";
export {
	FlushScheduler,
	type FlushSchedulerOptions,
	foldSession,
	type LocalCopy,
	OutboxUnavailableError,
	pullSession,
	readOutbox,
	type SyncState,
	type SyncStateStore,
	storeHead,
	UnsyncedCommitsError,
	type UploadResult,
	uploadSession,
} from "./client.ts";
export type { FileResult, SyncFileInfo, SyncFileSystem } from "./files.ts";
export { checkSessionId, FileSystemSyncRemote } from "./filesystem.ts";
export { decodeLogLines, encodeLogLine, LOG_VERSION, LogFormatError } from "./lines.ts";
export {
	type BatchInfo,
	HistoryUnavailableError,
	type JsonObject,
	LOG_START,
	type PutBatchResult,
	type RemoteHistory,
	type RemoteListing,
	remoteHead,
	remoteHistory,
	type Seq,
	type SessionChanges,
	type SessionSummary,
	type SessionSyncMaintenance,
	type SessionSyncStore,
} from "./remote.ts";
export { FileSyncStateStore } from "./state.ts";
