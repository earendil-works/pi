// Opening the backup target: a folder (`P2_BACKUP_DIR`) or a plugin's target by name (`P2_BACKUP`, `BackupTargets`),
// with this instance's device for a folder's slots.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { Context, NativeWatchable } from "@p2/app/v1";
import { type BackupTarget, FileSystemSyncRemote, LockedFile, type SessionSyncStore } from "@p2/app/v1/node";
import { type OpenBackupTarget, SERVER_STORE } from "./contract.ts";

/** How long a named target may take to be offered (its plugin's object activating after this one) before the open fails. */
const TARGET_WAIT_MS = 30_000;

type Offered = ReadonlyMap<string, { open(): Promise<OpenBackupTarget> }>;

/**
 * The open target: a folder's remote and this instance's device, or the named plugin's target. A plugin's object may
 * activate after the backup's: the open waits for its target (up to `TARGET_WAIT_MS`), then fails `transient` with why
 * (the plugin is not loaded); a later offer retries it at once (`retryOn`).
 */
export async function openTarget(
	target: BackupTarget,
	dataDir: string,
	targets: NativeWatchable<Offered>,
	context: Context,
): Promise<OpenBackupTarget> {
	if (target.kind === "folder")
		return {
			remote: openFolderRemote(target.path, dataDir),
			device: await deviceId(dataDir),
			server: SERVER_STORE,
		};
	const offered = targets.value.get(target.name) ?? (await offeredWithin(targets, target.name, context));
	// Not signed in or not reachable yet: the open fails `transient` and Chord retries it with backoff.
	return offered.open();
}

/** The target `name` once offered, or a rejection naming what is offered after `TARGET_WAIT_MS`. */
async function offeredWithin(
	targets: NativeWatchable<Offered>,
	name: string,
	context: Context,
): Promise<{ open(): Promise<OpenBackupTarget> }> {
	const watch = await targets.watch(context);
	try {
		return await new Promise((resolve, reject) => {
			const timer = setTimeout(
				() =>
					reject(
						new Error(
							`P2_BACKUP=${name}: no loaded plugin offers this backup target (offered: ${[...watch.value.keys()].join(", ") || "none"})`,
						),
					),
				TARGET_WAIT_MS,
			);
			timer.unref();
			const found = watch.value.get(name);
			if (found !== undefined) {
				clearTimeout(timer);
				resolve(found);
				return;
			}
			watch.start(async (call) => {
				if (call.kind !== "value") return;
				const offer = call.value.get(name);
				if (offer === undefined) return;
				clearTimeout(timer);
				resolve(offer);
			});
		});
	} finally {
		await watch.stop();
	}
}

/** The target as the log names it. */
export const describe = (target: BackupTarget): string => (target.kind === "folder" ? target.path : target.name);

/** A folder's remote, its paths resolved from `dataDir`. */
export function openFolderRemote(path: string, dataDir: string): SessionSyncStore {
	return new FileSystemSyncRemote(new NodeExecutionEnv({ cwd: dataDir }), path);
}

/** This instance's device ID: `device.json` in the data directory, as logins keep it (made on first use). */
async function deviceId(dataDir: string): Promise<string> {
	const file = new LockedFile(join(dataDir, "device.json"));
	try {
		return await file.withLockAsync(async (content) => {
			const data: unknown = JSON.parse(content ?? "{}");
			if (typeof data === "object" && data !== null && "id" in data && typeof data.id === "string" && data.id)
				return { result: data.id };
			const id = randomUUID();
			return { result: id, next: JSON.stringify({ ...(typeof data === "object" ? data : {}), id }) };
		});
	} finally {
		await file.close();
	}
}
