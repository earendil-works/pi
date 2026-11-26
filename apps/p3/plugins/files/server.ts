// The files plugin on the server: Files' members for one caller (`serveThing`: the things plugin admits every caller
// and registers the kind) and its download route (`download.ts`). Each call first reaches its machine as the caller
// (`reachMachine`: available to the caller in this workspace, through the things plugin's index), then places its
// path: absolute, resolved through symbolic links, never in Pi's own data folder, and never a folder that holds it
// for a change. The machine's files are the environments plugin's `MachineHost` (`ExecutionEnv`'s file system).

import { type Context, defineFacet, invalid } from "@earendil-works/p3/v1";
import type { FileError, FileInfo, Result } from "@earendil-works/p3/v1/server";
import { type MachineHost, MachineHosts, reachMachine } from "../environments/contract.server.ts";
import { Gives } from "../things/contract.server.ts";
import type { Caller } from "../things/contract.ts";
import { serveThing } from "../things/serve.ts";
import { DOWNLOAD_PATH, type Entry, FilesKind, HITS, type Hit, PAGE } from "./contract.ts";
import { serveDownload } from "./download.ts";
import { messages } from "./messages.ts";

/** How many paths a search walks at most, and for how long. */
const SEARCH_BOUNDS = { maxEntries: 50_000, timeoutMs: 5_000 };

export default defineFacet((host) => {
	serveThing(host, FilesKind, {
		one: { name: "Files" },
		implement: ({ workspace, thing }, { caller }, self) => {
			const hosts = self.registry(MachineHosts);
			// The server (trusted code) is no party anywhere: it reaches every machine without an answer.
			const gives = caller.kind === "server" ? undefined : self.get(Gives, { workspace, caller: keyOf(caller) });
			const reach = (machine: string) => reachMachine(machine, caller, gives?.answers.value[machine], hosts.value);
			return {
				entries: async ({ machine, path, after }, ctx) => {
					const at = reach(machine);
					const listed = must(await at.env.listDir(await placed(at, path, ctx), ctx));
					const sorted = listed
						.filter((info) => !hiddenIn(at, info.path))
						.map((info) => ({ key: sortKey(info), info }))
						.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
					const start = after === undefined ? 0 : sorted.findIndex(({ key }) => key > after);
					const page = start < 0 ? [] : sorted.slice(start, start + PAGE);
					const more = start >= 0 && start + PAGE < sorted.length;
					return {
						entries: page.map(({ info }) => entryOf(info)),
						...(more ? { next: page[page.length - 1]!.key } : {}),
					};
				},
				search: async ({ machine, path, query }, ctx) => {
					const at = reach(machine);
					return searched(at, await placed(at, path, ctx), query.toLowerCase(), ctx);
				},
				read: async ({ machine, path, offset, length }, ctx) => {
					const at = reach(machine);
					const reader = must(await at.env.openBinaryReader(await placed(at, path, ctx), undefined, ctx));
					try {
						const { size } = must(await reader.info(ctx));
						const bytes = length === 0 ? new Uint8Array() : must(await reader.read(offset, length, ctx));
						return { size, data: Buffer.from(bytes).toString("base64") };
					} finally {
						await reader.close(ctx);
					}
				},
				download: async ({ machine, path }, ctx) => {
					await placed(reach(machine), path, ctx);
					const query = new URLSearchParams({ workspace, thing, machine, path });
					return `${DOWNLOAD_PATH}?${query}`;
				},
				upload: async ({ machine, path, offset, data, last }, ctx) => {
					const at = reach(machine);
					const target = await placedNew(at, path, ctx);
					const partial = `${target}.p3-upload`;
					const bytes = Buffer.from(data, "base64");
					if (offset === 0) must(await at.env.writeFile(partial, bytes, ctx));
					else {
						const { size } = must(await at.env.fileInfo(partial, ctx));
						if (size !== offset) {
							throw invalid("args", `files: upload at ${offset}, ${size} bytes so far`, {
								message: messages.message("uploadOutOfOrder"),
							});
						}
						must(await at.env.appendFile(partial, bytes, ctx));
					}
					if (last) must(await at.env.renameFile(partial, target, ctx));
					return null;
				},
				rename: async ({ machine, from, to }, ctx) => {
					const at = reach(machine);
					const source = changeable(at, await placed(at, from, ctx));
					must(await at.env.renameFile(source, await placedNew(at, to, ctx), ctx));
					return null;
				},
				remove: async ({ machine, path }, ctx) => {
					const at = reach(machine);
					const target = changeable(at, await placed(at, path, ctx));
					must(await at.env.remove(target, { recursive: true }, ctx));
					return null;
				},
			};
		},
	});
	serveDownload(host);
});

/**
 * The paths below `folder` whose name contains `wanted` (lower case), at most `HITS`: the machine's own listing where
 * it has one, else a walk of the folders, breadth first, symbolic links not followed; both bounded by `SEARCH_BOUNDS`.
 */
async function searched(
	at: MachineHost,
	folder: string,
	wanted: string,
	context: Context,
): Promise<{ hits: Hit[]; truncated: boolean }> {
	const listing = await at.env.listFiles?.(folder, SEARCH_BOUNDS, context);
	const listed =
		listing === undefined || (!listing.ok && listing.error.code === "not_supported")
			? await walked(at, folder, context)
			: must(listing);
	const hits: Hit[] = [];
	for (const entry of listed.entries) {
		const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
		if (!name.toLowerCase().includes(wanted)) continue;
		const full = folder === "/" ? `/${entry.path}` : `${folder}/${entry.path}`;
		if (hiddenIn(at, full)) continue;
		if (hits.length === HITS) return { hits, truncated: true };
		hits.push({ path: full, kind: entry.kind });
	}
	return { hits, truncated: listed.truncated };
}

/** What a machine without a listing of its own has below `folder`, as a listing: paths relative to it. */
async function walked(
	at: MachineHost,
	folder: string,
	context: Context,
): Promise<{ entries: { path: string; kind: FileInfo["kind"] }[]; truncated: boolean }> {
	const deadline = Date.now() + SEARCH_BOUNDS.timeoutMs;
	const entries: { path: string; kind: FileInfo["kind"] }[] = [];
	const queue = [""];
	for (let next = 0; next < queue.length; next++) {
		const relative = queue[next]!;
		const listed = await at.env.listDir(relative === "" ? folder : `${folder}/${relative}`, context);
		// A folder that cannot be read is left out, as a listing skips it.
		if (!listed.ok) continue;
		for (const info of listed.value) {
			if (entries.length === SEARCH_BOUNDS.maxEntries || Date.now() > deadline) return { entries, truncated: true };
			if (info.name === ".git") continue;
			const path = relative === "" ? info.name : `${relative}/${info.name}`;
			entries.push({ path, kind: info.kind });
			if (info.kind === "directory") queue.push(path);
		}
	}
	return { entries, truncated: false };
}

/** The caller's key as `Gives` takes it (`callerKey` of its principal). */
function keyOf(caller: Exclude<Caller, { kind: "server" }>): string {
	return caller.kind === "person" ? `person:${caller.person}` : `worker:${caller.session}`;
}

/** Where `path` is on `at`, resolved through symbolic links; refused when it is relative or hidden. */
async function placed(at: MachineHost, path: string, context: Context): Promise<string> {
	if (!path.startsWith("/")) {
		throw invalid("args", `files: ${path} is not absolute`, { message: messages.message("notAbsolute") });
	}
	const real = must(await at.env.canonicalPath(path, context));
	if (hiddenIn(at, real)) throw hidden(real);
	return real;
}

/** Where a new file or folder `path` goes on `at`: in a folder that exists, placed as `placed` places it. */
async function placedNew(at: MachineHost, path: string, context: Context): Promise<string> {
	const slash = path.lastIndexOf("/");
	const name = path.slice(slash + 1);
	if (name === "" || name === "." || name === "..") {
		throw invalid("args", `files: ${path} names no file`, { message: messages.message("notFound") });
	}
	const folder = await placed(at, slash === 0 ? "/" : path.slice(0, slash), context);
	const target = folder === "/" ? `/${name}` : `${folder}/${name}`;
	if (hiddenIn(at, target)) throw hidden(target);
	return target;
}

/** `real`, unless removing or moving it would take the root or a folder holding Pi's data folder with it. */
function changeable(at: MachineHost, real: string): string {
	if (real === "/") throw invalid("args", "files: the root folder", { message: messages.message("root") });
	for (const folder of at.hidden) if (folder.startsWith(`${real}/`)) throw hidden(real);
	return real;
}

/** Whether `path` (resolved) is in one of `at`'s hidden folders. */
function hiddenIn(at: MachineHost, path: string): boolean {
	return at.hidden.some((folder) => path === folder || path.startsWith(`${folder}/`));
}

/** The refusal of a hidden path. */
function hidden(path: string) {
	return invalid("args", `files: ${path} is hidden`, { message: messages.message("hidden") });
}

/** An entry's place in a folder's order: folders first, then by name (byte order). */
function sortKey(info: FileInfo): string {
	return `${info.kind === "directory" ? 0 : 1}/${info.name}`;
}

/** An entry as the contract has it. */
function entryOf(info: FileInfo): Entry {
	return {
		name: info.name,
		path: info.path,
		kind: info.kind,
		size: info.size,
		modified: Math.max(0, Math.floor(info.mtimeMs)),
	};
}

/** `result`'s value, or its error as the caller sees it. */
function must<T>(result: Result<T, FileError>): T {
	if (result.ok) return result.value;
	const { code, message } = result.error;
	if (code === "not_found") throw invalid("args", `files: ${message}`, { message: messages.message("notFound") });
	throw refused(message);
}

/** The machine's refusal, `reason` shown. */
function refused(reason: string) {
	return invalid("args", `files: ${reason}`, { message: messages.message("failed", reason) });
}
