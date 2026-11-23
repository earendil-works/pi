// Whether this instance backs up its Chord stores, and where to (`plugins/backup` does the backup). The hosts read it
// where they open stores: a store keeps an outbox only while backup is configured, so the server and each worker open
// their store with `outbox: backupConfigured()`. Offline tools open stores without the option, keeping what is stored.
// An outbox turned off drops its commits; turned on again, it starts at the store's head, so the next upload is a full
// copy of the store after what the backup holds (Chord's archive slot), and the backup goes on from there.

/**
 * Where this instance backs up to: a folder (a local disk, a mounted bucket or NAS; tests), or a plugin's target by its
 * name (`radius`: the Radius this instance is signed in to, `BackupTargets`).
 */
export type BackupTarget =
	| { readonly kind: "folder"; readonly path: string }
	| { readonly kind: "named"; readonly name: string };

/**
 * The backup target from the environment, or undefined when backup is off: `P2_BACKUP_DIR=<path>` for a folder,
 * `P2_BACKUP=<name>` for a plugin's target (`radius`). Both set is a mistake, refused.
 */
export function backupTarget(env: NodeJS.ProcessEnv = process.env): BackupTarget | undefined {
	const path = env.P2_BACKUP_DIR;
	const name = env.P2_BACKUP;
	if (path && name) throw new Error("Set P2_BACKUP_DIR (a folder) or P2_BACKUP (a target such as radius), not both");
	if (path) return { kind: "folder", path };
	if (name) return { kind: "named", name };
	return undefined;
}

/** Whether stores keep an outbox: backup is configured. Read where stores open (server, worker). */
export function backupConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
	return backupTarget(env) !== undefined;
}
