// The server's backup (`contract.ts`): holds the backup remote, uploads the server's own store, gives each
// session's worker the remote for its own store (`BackupRemote`: slot bodies streamed through here in chunks), and
// keeps every store's last reported status. Inert while backup is not configured (`P2_BACKUP_DIR` for a folder,
// `P2_BACKUP=<name>` for a plugin's target such as `radius`, `BackupTargets`).
import {
	defineFacet,
	forbidden,
	isWorker,
	nativeOf,
	PluginError,
	serveKeyed,
	serveNative,
	withoutAbortSignal,
} from "@p2/app/v1";
import { backupTarget, processLogs, serverDirectory } from "@p2/app/v1/node";
import { Server, serverOf } from "@p2/app/v1/server";
import {
	BACKUP_OFF,
	Backup,
	BackupNative,
	BackupRemote,
	type BackupStatus,
	BackupTargets,
	type BackupUploads,
	type OpenBackup,
	SERVER_STORE,
	sessionStoreName,
} from "./contract.ts";
import { describe, openTarget } from "./target.ts";
import { BackupUploader, backupFiles, backupTargetKey, errorText } from "./uploader.ts";
import { openUploads } from "./uploads.ts";

export default defineFacet((host) => {
	serveNative(host, BackupNative);
	serveKeyed(host, BackupTargets);
	host.serve(Backup, (_params, self) => {
		const server = self.get(Server, {});
		const natives = serverOf(self);
		const statuses = self.writable<Record<string, BackupStatus>>({});
		const device = self.writable<string | null>(null);
		// Set while this object runs; the server store's last upload reports after it ended (its close), to the log only.
		let ended = false;
		const report = (store: string, status: BackupStatus): void => {
			if (!ended) statuses.set({ ...statuses.value, [store]: status });
			if (status.state === "error" || status.state === "behind" || status.state === "diverged")
				processLogs.append(`backup:${store}`, "event", `${status.state}${status.error ? `: ${status.error}` : ""}`);
		};
		// The remote, this instance's device, the uploads workers stream through it, and the server store's uploader (its
		// outbox is on while backup is configured: the server opens the store so).
		const targets = self.registry(BackupTargets);
		const backup = self.open(
			async (context) => {
				const target = backupTarget();
				const store = natives().store;
				if (target === undefined || store === undefined) return undefined;
				const { dataDir } = server.info.value;
				const opened = await openTarget(target, dataDir, targets, context);
				device.set(opened.device);
				const uploads = openUploads(opened.remote, opened.device, withoutAbortSignal(context), opened.terminal);
				// Who the target writes as now; null for a target without accounts (a folder).
				const account = async (): Promise<string | null> => (await opened.account?.()) ?? null;
				const uploader = new BackupUploader({
					store,
					name: opened.server,
					device: opened.device,
					remote: opened.remote,
					directory: serverDirectory(dataDir),
					target: backupTargetKey(target),
					files: backupFiles(dataDir),
					account,
					report: (status) => report(SERVER_STORE, status),
					...(opened.terminal === undefined ? {} : { terminal: opened.terminal }),
				});
				// The server's store is written by many objects: the store tells of every commit. Uploading writes nothing
				// to the store (its bookmark is a file, its outbox trim no commit), so this never wakes itself.
				const stopWatching = store.onCommitted(
					() => uploader.committed(false),
					(error) => processLogs.append("backup:server", "event", `following commits failed: ${errorText(error)}`),
				);
				processLogs.append("backup", "event", `Backing up to ${describe(target)} as device ${opened.device}`);
				return { uploads, account, uploader, stopWatching };
			},
			async (opened) => {
				ended = true;
				if (opened === undefined) return;
				opened.stopWatching();
				opened.uploads.close();
				await opened.uploader.close().catch((error: unknown) => report(SERVER_STORE, failed(error)));
			},
		);
		// A target offered (its plugin's object activated, loaded or reloaded) after a failed open: try at once.
		self.retryOn(targets);
		self.contribute(BackupNative, {
			get backup() {
				return backup.value;
			},
		});
		return {
			device: self.derive([device], ([value]) => value),
			statuses: self.derive([statuses], ([value]) => value),
			report: async ({ store, status }) => {
				report(store, status);
				return null;
			},
		};
	});

	host.serve(BackupRemote, (_params, principal, self) => {
		// Only a session's own worker uploads, and only its own store: named from the principal, never from arguments.
		if (!isWorker(principal)) throw forbidden("the backup remote is for session workers");
		const store = sessionStoreName(principal.session);
		const backup = self.get(Backup, {});
		const native = nativeOf(self, BackupNative, "The backup");
		const open = (): OpenBackup => {
			const opened = native().backup;
			if (opened === undefined) throw new PluginError(BACKUP_OFF, "Backup is off");
			return opened;
		};
		const uploads = (): BackupUploads => open().uploads;
		return {
			variant: "worker",
			members: {
				device: backup.device,
				report: ({ status }, ctx) => backup.report({ store, status }, ctx),
				begin: (slot) => uploads().begin(store, slot),
				append: async ({ upload, bytes }) => {
					await uploads().append(store, upload, bytes);
					return null;
				},
				finish: ({ upload }) => uploads().finish(store, upload),
				abort: async ({ upload }) => {
					uploads().abort(store, upload);
					return null;
				},
				account: () => open().account(),
			},
		};
	});
});

const failed = (error: unknown): BackupStatus => ({ state: "error", error: errorText(error), at: Date.now() });
