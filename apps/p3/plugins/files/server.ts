// The files plugin on the server: Files' members for one caller (`serveThing`: the things plugin admits every caller
// and registers the kind) and its two routes (transfers.ts). Each call first reaches its machine as the caller
// (`reachMachine`: available to the caller in this workspace, through the things plugin's index), then places its
// path (places.ts). The machine's files are the environments plugin's `MachineHost`. A folder's page reads the folder's
// names once and reads only the page's entries.

import { type Context, defineFacet } from "@earendil-works/p3/v1";
import { type MachineHost, MachineHosts, type NameEntry, reachMachine } from "../environments/contract.server.ts";
import { givesTo } from "../things/contract.server.ts";
import { serveThing } from "../things/serve.ts";
import { DOWNLOAD_PATH, type Entry, FilesKind, type Hit, UPLOAD_PATH } from "./contract.ts";
import { hiddenIn, must, placed, placedEntry, placedNew, refusalOf } from "./places.ts";
import { serveTransfers } from "./transfers.ts";

/** How many entries one page of `entries` holds. */
const PAGE = 200;

/** How many hits `search` answers at most. */
const HITS = 200;

/** How many entries a search walks at most, and for how long. */
const SEARCH_BOUNDS = { maxEntries: 50_000, timeoutMs: 5_000 };

export default defineFacet((host) => {
	serveThing(host, FilesKind, {
		one: { name: "Files" },
		implement: ({ workspace, thing }, { caller }, self) => {
			const hosts = self.registry(MachineHosts);
			const answers = givesTo(self, workspace, caller);
			const reach = (machine: string, ctx: Context) =>
				reachMachine(machine, caller, answers.value[machine], hosts.value, ctx);
			const address = (route: string, machine: string, path: string) =>
				`${route}?${new URLSearchParams({ workspace, thing, machine, path })}`;
			return {
				entries: async ({ machine, path, after }, ctx) => {
					const at = await reach(machine, ctx);
					return paged(at, await placed(at, path, ctx), after, ctx);
				},
				search: async ({ machine, path, query }, ctx) => {
					const at = await reach(machine, ctx);
					return searched(at, await placed(at, path, ctx), query.toLowerCase(), ctx);
				},
				open: async ({ machine, path }, ctx) => {
					await placed(await reach(machine, ctx), path, ctx);
					return { url: address(DOWNLOAD_PATH, machine, path) };
				},
				upload: async ({ machine, path }, ctx) => {
					await placedNew(await reach(machine, ctx), path, ctx);
					return { url: address(UPLOAD_PATH, machine, path) };
				},
				rename: async ({ machine, from, to }, ctx) => {
					const at = await reach(machine, ctx);
					const source = await placedEntry(at, from, ctx);
					must(await at.env.renameFile(source.path, await placedNew(at, to, ctx), ctx));
					return null;
				},
				remove: async ({ machine, path }, ctx) => {
					const at = await reach(machine, ctx);
					const entry = await placedEntry(at, path, ctx);
					// `rm` takes a link itself, never what it points to.
					must(await at.env.remove(entry.path, { recursive: entry.kind === "directory" }, ctx));
					return null;
				},
			};
		},
	});
	serveTransfers(host);
});

/**
 * One page of `folder`'s entries after the sort key `after`: the names read once and sorted, only the page's entries
 * read (one `lstat` each); an entry gone meanwhile is left out.
 */
async function paged(
	at: MachineHost,
	folder: string,
	after: string | undefined,
	context: Context,
): Promise<{ entries: Entry[]; next?: string }> {
	const sorted = (await names(at, folder, context))
		.filter(({ name }) => !hiddenIn(at, joined(folder, name)))
		.map((entry) => ({ key: sortKey(entry), entry }))
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	const start = after === undefined ? 0 : sorted.findIndex(({ key }) => key > after);
	const page = start < 0 ? [] : sorted.slice(start, start + PAGE);
	const read = await Promise.all(page.map(({ entry }) => at.env.fileInfo(joined(folder, entry.name), context)));
	const entries: Entry[] = [];
	for (const info of read) {
		if (!info.ok) continue;
		const { name, path, kind, size, mtimeMs } = info.value;
		entries.push({ name, path, kind, size, modified: Math.max(0, Math.floor(mtimeMs)) });
	}
	const more = start >= 0 && start + PAGE < sorted.length;
	return { entries, ...(more ? { next: page[page.length - 1]!.key } : {}) };
}

/**
 * The paths below `folder` whose name contains `wanted` (lower case), at most `HITS`: a walk of the folders, breadth
 * first, symbolic links, `.git` and hidden folders not entered; bounded by `SEARCH_BOUNDS` and `context`'s abort.
 */
async function searched(
	at: MachineHost,
	folder: string,
	wanted: string,
	context: Context,
): Promise<{ hits: Hit[]; truncated: boolean }> {
	const deadline = Date.now() + SEARCH_BOUNDS.timeoutMs;
	const hits: Hit[] = [];
	const queue = [folder];
	let walked = 0;
	for (let next = 0; next < queue.length; next++) {
		context.abortSignal?.throwIfAborted();
		// A folder that cannot be read is left out.
		const listed = await names(at, queue[next]!, context).catch(() => []);
		for (const { name, kind } of listed) {
			if (walked++ === SEARCH_BOUNDS.maxEntries || Date.now() > deadline) return { hits, truncated: true };
			const path = joined(queue[next]!, name);
			if (name === ".git" || hiddenIn(at, path)) continue;
			if (name.toLowerCase().includes(wanted)) {
				if (hits.length === HITS) return { hits, truncated: true };
				hits.push({ path, kind });
			}
			if (kind === "directory") queue.push(path);
		}
	}
	return { hits, truncated: false };
}

/** `folder`'s names and kinds; a machine's failure as the caller sees it. */
async function names(at: MachineHost, folder: string, context: Context): Promise<readonly NameEntry[]> {
	try {
		return await at.listNames(folder, context);
	} catch (error) {
		// A trust boundary: Node's errors carry their code.
		const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
		throw refusalOf(code, error instanceof Error ? error.message : String(error));
	}
}

/** `name` in `folder`. */
function joined(folder: string, name: string): string {
	return folder === "/" ? `/${name}` : `${folder}/${name}`;
}

/** An entry's place in a folder's order: folders first, then by name (byte order). */
function sortKey(entry: NameEntry): string {
	return `${entry.kind === "directory" ? 0 : 1}/${entry.name}`;
}
