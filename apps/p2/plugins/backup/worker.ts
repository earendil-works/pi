// A session's worker uploads its own store (one writer per store) through the server's `BackupRemote`: soon after a
// commit (about 200 ms after an urgent one: what the user sent, a finished answer), and once more as the worker stops.
// Inert while backup is off (the server's `device` is null). The device is the server's: the one it stamps on every
// slot, which an upload compares with a taken slot's to tell its own lost answer from another machine's upload.
import { defineFacet, expectVariant, local, untilAborted } from "@p2/app/v1";
import {
	BackupUploader,
	backupFiles,
	backupTarget,
	backupTargetKey,
	isTerminalBackupError,
	isUrgentCommit,
	processLogs,
	sessionDirectory,
	sessionStoreName,
} from "@p2/app/v1/node";
import { harnessOf, workerOf } from "@p2/app/v1/worker";
import { ChunkedRemote } from "./chunked-remote.ts";
import { BackupRemote } from "./contract.ts";

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
			if (device === null || target === undefined) return;
			const { init, store, root } = worker();
			if (store === undefined) return;
			const session = init.values.session.id;
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
				// A status the server misses is replaced by the next one; the failure goes to the session's log.
				report: (status) =>
					void root(
						async (inner) => expectVariant(await inner.get(BackupRemote, {}), "worker").report({ status }, inner),
						ctx,
					).catch((error: unknown) => log(`reporting the backup status failed: ${text(error)}`)),
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
					.catch((error: unknown) => log(`the last upload failed (kept for the next start): ${text(error)}`));
			}
		});
		return {};
	});
});

const text = (error: unknown): string => (error instanceof Error ? error.message : String(error));
