// Shared development control protocol. No credentials or transport addresses belong in browser state.
export type DevCommand = { action: "reload"; plugins?: readonly string[] } | { action: "restart" };
export type DevResult = { ok: boolean; message: string; plugins?: readonly string[] };
export type DevStatus = {
	revision: number;
	phase: "idle" | "reloading" | "ready" | "error";
	plugins: readonly string[];
	dirty: readonly string[];
	restartNeeded: boolean;
	/** Loaded server/worker files whose content differs from their running copy (project-relative). */
	restartFiles: readonly string[];
	message?: string;
	noticeId?: string;
	/** Event time of the last result; unrelated dirty/revision changes do not refresh it. */
	noticeTime?: number;
	hasLogs?: boolean;
};

export type DevModule = { readonly file: string; readonly hash: string };

/** Private worker-to-server metadata, separate from chord2 control/frames. */
export function parseDevModules(value: unknown): readonly DevModule[] | undefined {
	if (
		!value ||
		typeof value !== "object" ||
		!("type" in value) ||
		value.type !== "dev-modules" ||
		!("modules" in value) ||
		!Array.isArray(value.modules)
	)
		return undefined;
	const modules: DevModule[] = [];
	for (const entry of value.modules) {
		if (
			!entry ||
			typeof entry !== "object" ||
			!("file" in entry) ||
			typeof entry.file !== "string" ||
			!("hash" in entry) ||
			typeof entry.hash !== "string" ||
			!/^[a-f0-9]{64}$/.test(entry.hash)
		)
			return undefined;
		modules.push({ file: entry.file, hash: entry.hash });
	}
	return modules;
}

/** Plugin files a worker loaded through the facet loader (absolute paths), from the same message. */
export function parseDevPluginFiles(value: unknown): readonly string[] | undefined {
	if (
		!value ||
		typeof value !== "object" ||
		!("type" in value) ||
		value.type !== "dev-modules" ||
		!("pluginFiles" in value) ||
		!Array.isArray(value.pluginFiles) ||
		!value.pluginFiles.every((file: unknown) => typeof file === "string")
	)
		return undefined;
	return value.pluginFiles as string[];
}

export function parseDevCommand(value: unknown): DevCommand {
	if (!value || typeof value !== "object" || !("action" in value)) throw new Error("Invalid dev command");
	if (value.action === "restart") return { action: "restart" };
	if (value.action !== "reload") throw new Error("Invalid dev action");
	if (!("plugins" in value) || value.plugins === undefined) return { action: "reload" };
	if (
		!Array.isArray(value.plugins) ||
		value.plugins.length > 100 ||
		!value.plugins.every((name: unknown) => typeof name === "string" && /^[a-z0-9][a-z0-9_-]{0,99}$/.test(name))
	)
		throw new Error("Invalid plugin names");
	return { action: "reload", plugins: [...new Set<string>(value.plugins)] };
}
