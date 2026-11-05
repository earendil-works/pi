import type { ConversationId } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { type Ctx, canSend, defineFacet, FileIndex, FileIndexCache, type FileItem, forbidden } from "@p2/app/v1";
import { conversationEnvironment, harnessOf, isLocalEnvironment, workerOf } from "@p2/app/v1/worker";
import { WorkspaceBackend, workspacePath } from "../workspace/contract.ts";
import { inside, listIndex } from "./listing.ts";
import { rankFiles, withDirectories } from "./rank.ts";

/** A rebuild at most this often while files keep changing: completion may lag a burst of writes by this much. */
const REBUILD_MS = 1000;

/** Prefixes outside the session directory: completion is cwd-relative (section 8.2). */
export const outOfScope = (query: string): boolean => /^(?:\/|~|\.\.(?:\/|$))/.test(query);

export default defineFacet((host) => {
	host.serve(
		FileIndexCache,
		({ conversation }, self) => {
			// The workspace's environment, confinement, private-path exclusion and watch (its `changes` counter).
			const backend = self.get(WorkspaceBackend, { conversation });
			const harness = harnessOf(self);
			const worker = workerOf(self);
			// The environment found unable to list (no daemon `listFiles`): the workspace's index while it is in use. A
			// move brings other environments, which are tried again.
			let unsupported: ExecutionEnv | undefined;
			/**
			 * The environment's own listing, with the workspace's confinement (workspace/worker.ts: the conversation's
			 * location, canonical root, p2's private data directory for local sessions). `undefined` falls back to the
			 * workspace's index, which also reports a private or unavailable working directory.
			 */
			const listed = async (ctx: Ctx) => {
				try {
					return await worker().liveness.call(async () => {
						const handle = await harness().durable.conversation(conversation as ConversationId, ctx);
						if (!handle) return undefined;
						const { env } = await conversationEnvironment(harness().environments, handle.id, ctx);
						if (env === unsupported) return undefined;
						if (env.listFiles === undefined) {
							unsupported = env;
							return undefined;
						}
						const root = await env.canonicalPath(env.cwd, ctx);
						if (!root.ok) return undefined;
						const init = worker().init;
						// Decided from the environment, not the location, which lags behind it during a move.
						const privatePath = isLocalEnvironment(env) ? await env.canonicalPath(init.dataDir, ctx) : undefined;
						const denied = privatePath === undefined ? [] : [privatePath.ok ? privatePath.value : init.dataDir];
						if (denied.some((directory) => inside(directory, root.value))) return undefined;
						const result = await listIndex(env, root.value, denied, ctx);
						if (result === undefined) unsupported = env;
						return result;
					});
				} catch {
					// A failed listing (a lost connection, an abort) is retried by the workspace's index, which reports it.
					return undefined;
				}
			};
			// An index belongs to a location version: after a move neither the cached index nor a build in flight is used.
			type Index = { version: number; changes: number; items: FileItem[]; truncated: boolean; at: number };
			let index: Index | undefined;
			let building: { readonly version: number; readonly index: Promise<Index> } | undefined;
			/** Keeps `built` unless a move made it older meanwhile (it still answers the request it was built for). */
			const keep = (built: Index): Index => {
				if (built.version === worker().location.version) index = built;
				return built;
			};
			const current = (ctx: Ctx): Promise<Index> => {
				const version = worker().location.version;
				const changes = backend.changes.value;
				if (index?.version === version && (index.changes === changes || Date.now() - index.at < REBUILD_MS))
					return Promise.resolve(index);
				if (building?.version === version) return building.index;
				const build = (async (): Promise<Index> => {
					try {
						const own = await listed(ctx);
						if (own) return keep({ version, changes, ...own, at: Date.now() });
						// Tracked and untracked files without ignored ones (git), else a bounded walk; directories derive from
						// the file paths (workspace/environment.ts `files`).
						const result = await backend.query({ kind: "files" }, ctx);
						if (result.kind !== "files") throw new Error("Unexpected workspace result");
						return keep({
							version,
							changes,
							items: withDirectories(result.paths),
							truncated: result.truncated,
							at: Date.now(),
						});
					} finally {
						// A build for this version is the only one: requests for it share it.
						if (building?.version === version) building = undefined;
					}
				})();
				building = { version, index: build };
				return build;
			};
			return {
				changes: backend.changes,
				complete: async ({ query, limit, kind }, ctx) => {
					if (outOfScope(query)) return { items: [], truncated: false };
					const { items, truncated } = await current(ctx);
					return { items: rankFiles(items, query, { limit: limit ?? 20, kind: kind ?? "any" }), truncated };
				},
				list: async ({ path }, ctx) => {
					const relative = path.replace(/\/+$/, "");
					if (relative && workspacePath(relative) === undefined) throw new Error("Invalid path");
					const result = await backend.query({ kind: "list", path: relative }, ctx);
					if (result.kind !== "list") throw new Error("Unexpected workspace result");
					return {
						entries: result.entries.map((entry) => ({ name: entry.name, dir: entry.kind === "directory" })),
						truncated: result.truncated,
					};
				},
			};
		},
		// Typing pauses keep the index; switching back to a conversation soon reuses it.
		{ linger: 60_000 },
	);

	host.serve(FileIndex, ({ session, conversation }, principal, self) => {
		// Participants only, as the workspace (canSend): view-only guests get no file names.
		if (!canSend(principal, session)) throw forbidden("participants only");
		const cache = self.get(FileIndexCache, { conversation });
		return {
			variant: "reader",
			members: {
				changes: cache.changes,
				complete: (args, ctx) => cache.complete(args, ctx),
				list: (args, ctx) => cache.list(args, ctx),
			},
		};
	});
});
