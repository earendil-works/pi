// A session's worker uploads its own store (one writer per store) through the server's `BackupRemote`: soon after a
// commit (about 200 ms after an urgent one: what the user sent, a finished answer), and once more as the worker stops.
// Inert while backup is off (the server's `device` is null). The device is the server's: the one it stamps on every
// slot, which an upload compares with a taken slot's to tell its own lost answer from another machine's upload.
import type { CommitPublication } from "@earendil-works/pi-durable";
import { defineFacet, expectVariant, INPUT_ENTRY, local, untilAborted } from "@p2/app/v1";
import { backupTarget, processLogs, sessionDirectory } from "@p2/app/v1/node";
import { harnessOf, workerOf } from "@p2/app/v1/worker";
import { ChunkedRemote } from "./chunked-remote.ts";
import { BackupRemote, isTerminalBackupError, sessionStoreName } from "./contract.ts";
import { BackupUploader, backupFiles, backupTargetKey, errorText, pausedWhileOff } from "./uploader.ts";

/** The worker's backup of its store, for the worker's life. */
const StoreBackup = local("p2.store-backup", { version: 1, params: {}, members: {} });

export default defineFacet((host) => {
	host.serve(StoreBackup, (_params, self) => {
		const worker = workerOf(self);
		const harness = harnessOf(self);
		const remote = self.get(BackupRemote, {});
		self.onLive(async (ctx) => {
			const device = expectVariant(remote, "worker").device.value;
			const target = backupTarget();
			const { init, store, root } = worker();
			const session = init.values.session.id;
			if (target === undefined) {
				// Backup is off: a store backed up before says so (paused), instead of nothing.
				const files = backupFiles(init.dataDir);
				const paused = await pausedWhileOff(files, sessionDirectory(init.dataDir, session), ctx);
				if (paused !== undefined) await expectVariant(remote, "worker").report({ status: paused }, ctx);
				return;
			}
			if (device === null || store === undefined) return;
			const name = sessionStoreName(session);
			const log = (message: string): void => processLogs.append(`backup:${name}`, "event", message);
			const uploader = new BackupUploader({
				store,
				name,
				device,
				remote: new ChunkedRemote(name, (fn, context) =>
					root(async (inner) => fn(expectVariant(await inner.get(BackupRemote, {}), "worker"), inner), context),
				),
				directory: sessionDirectory(init.dataDir, session),
				// The server's target (the worker inherits its environment): bookmarks are per target.
				target: backupTargetKey(target),
				files: backupFiles(init.dataDir),
				// What the server's target refuses for good crosses as `BACKUP_TERMINAL`: stop, as the server does.
				terminal: isTerminalBackupError,
				// The account the server's target writes as now: asked on every upload, as the server may sign in again.
				account: (context) =>
					root(
						async (inner) => expectVariant(await inner.get(BackupRemote, {}), "worker").account({}, inner),
						context,
					),
				// A status the server misses is replaced by the next one; the failure goes to the session's log.
				report: (status) =>
					void root(
						async (inner) => expectVariant(await inner.get(BackupRemote, {}), "worker").report({ status }, inner),
						ctx,
					).catch((error: unknown) => log(`reporting the backup status failed: ${errorText(error)}`)),
			});
			// Every commit of the session's Durable records; the urgent ones leave the machine first.
			const observation = harness().durable.observeCommits({
				advance: (publication) => uploader.committed(isUrgentCommit(publication)),
				end: () => {},
			});
			try {
				await untilAborted(ctx);
			} finally {
				observation.detach();
				// The worker is stopping: what is left goes now. A failure keeps it in the outbox for the next start.
				await uploader
					.close()
					.catch((error: unknown) => log(`the last upload failed (kept for the next start): ${errorText(error)}`));
			}
		});
		return {};
	});
});

/** Entries that should leave the machine soon: what a person sent (p2's input, Durable's user entry) and an answer. */
const URGENT_ENTRIES: ReadonlySet<string> = new Set([INPUT_ENTRY, "pi.user", "pi.assistant"]);

/**
 * Whether a session commit should be uploaded soon (about 200 ms) rather than with the next ordinary flush (5 s): what
 * the user sent, a finished answer, a settled submission. A host that may be stopped any time (a Durable Object evicted
 * after idling) then loses at most the last moments of a turn, never a whole exchange.
 */
export function isUrgentCommit(publication: CommitPublication): boolean {
	return publication.changes.some(
		(change) =>
			(change.type === "entry" && URGENT_ENTRIES.has(change.value.kind)) ||
			(change.type === "submission" && (change.value.status === "done" || change.value.status === "unanswered")),
	);
}
