// The index from the environment's own listing (pi-env's `listFiles`, section 8.3 item 2), when it has one. Pure
// over an `ExecutionEnv`; the worker facet supplies the conversation's environment and the workspace's confinement.

import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Context, FileItem } from "@p2/app/v1";

/** The workspace index's bounds (workspace/environment.ts `FILES_LIMIT`, `FILES_BYTES`, `GIT_TIMEOUT`). */
const LIST_ENTRIES = 50_000;
const LIST_BYTES = 4 * 1024 * 1024;
const LIST_TIMEOUT_MS = 10_000;

/** Whether `path` is `base` or below it (canonical absolute paths, `/` separators). */
export const inside = (base: string, path: string): boolean =>
	path === base || path.startsWith(base === "/" ? "/" : `${base}/`);

/**
 * Files and directories below `root` (the canonical working directory) from `env.listFiles`: empty and hidden
 * directories included; `.git`, `node_modules` and, in a git work tree, what git ignores left out; symbolic links
 * listed as files and not followed. Entries in a `denied` directory (canonical; p2's private data) are left out, as
 * the workspace leaves them out. `undefined` when the environment cannot list: no `listFiles` (`NodeExecutionEnv`),
 * or a daemon released before it (`not_supported`); the caller then uses the workspace's git/walk index. Other
 * failures are thrown.
 */
export async function listIndex(
	env: ExecutionEnv,
	root: string,
	denied: readonly string[],
	context: Context,
): Promise<{ items: FileItem[]; truncated: boolean } | undefined> {
	if (env.listFiles === undefined) return undefined;
	const listed = await env.listFiles(
		root,
		{ exclude: ["node_modules"], maxEntries: LIST_ENTRIES, maxBytes: LIST_BYTES, timeoutMs: LIST_TIMEOUT_MS },
		context,
	);
	if (!listed.ok) {
		if (listed.error.code === "not_supported") return undefined;
		throw listed.error;
	}
	const base = root.replace(/\/+$/, "");
	const items: FileItem[] = [];
	for (const entry of listed.value.entries) {
		if (denied.length > 0 && denied.some((directory) => inside(directory, `${base}/${entry.path}`))) continue;
		items.push({ path: entry.path, dir: entry.kind === "directory" });
	}
	return { items, truncated: listed.value.truncated };
}
