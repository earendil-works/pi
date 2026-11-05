// Chord v2's app kit (`@earendil-works/chord/app`; slice 13): `startServer` on the server and `startWorker` in a
// worker's entry, the start-data objects, sessions and the owner's sign-in, device pairing, the files of each host,
// export and import per address, and the optional plugins (users, invites, ephemeral login).

export {
	type App,
	type AppApi,
	type AppError,
	type AppKind,
	type AppOptions,
	type AppPlugins,
	type AppTimeouts,
	type AppWorkerKind,
	Server,
	startServer,
} from "./app.ts";
export { ARCHIVE_FORMAT, type ArchiveManifest } from "./archive.ts";
export { type EphemeralUser, ephemeralLoginFacet } from "./ephemeral.ts";
export { type FileInfo, Files, type FilesCaps } from "./files.ts";
export { AppInfo, WorkerInfo } from "./info.ts";
export { inviteFacet } from "./invite.ts";
export { OWNER, type OwnerPrincipal } from "./owner.ts";
export { SESSION_COOKIE, type SessionInfo, type SessionKind, Sessions } from "./sessions.ts";
export { defineUsers } from "./users.ts";
export { startWorker, type WorkerOptions } from "./worker.ts";
