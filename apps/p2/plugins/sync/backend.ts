// Selects the session-sync remote without coupling backup now, or broader synchronization later, to one backend.
import type { SessionSyncStore, SyncFileSystem } from "@earendil-works/chord/sync";
import { FileSystemSyncRemote } from "@earendil-works/chord/sync";
import { type RadiusSyncAccess, RadiusSyncRemote } from "./radius-remote.ts";

/** The session-sync storage selected for this P2 instance; initially used only for backup and restore. */
export type SessionSyncBackend =
	| { readonly type: "off" }
	| { readonly type: "filesystem"; readonly directory: string }
	| { readonly type: "radius" };

/** Session sync stays off until the owner selects a remote backend. */
export const DEFAULT_SESSION_SYNC_BACKEND: SessionSyncBackend = { type: "off" };

/** Dependencies supplied by P2 around the backend-specific adapters. */
export type SessionSyncBackendDependencies = {
	readonly files: SyncFileSystem;
	readonly radiusAccess: () => Promise<RadiusSyncAccess>;
	readonly fetch?: typeof fetch;
};

/** The selected Chord sync remote, or no remote when synchronization is off. */
export function selectSessionSyncRemote(
	backend: SessionSyncBackend,
	dependencies: SessionSyncBackendDependencies,
): SessionSyncStore | undefined {
	switch (backend.type) {
		case "off":
			return undefined;
		case "filesystem":
			return new FileSystemSyncRemote(dependencies.files, backend.directory);
		case "radius":
			return new RadiusSyncRemote(dependencies.radiusAccess, dependencies.fetch);
	}
}
