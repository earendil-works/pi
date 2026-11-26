// Where a path is on a machine, as Files acts on it: absolute, never in a folder the machine hides (Pi's own data
// folder), resolved through symbolic links for reading (`placed`), with the last component kept as it is for a change
// of the entry itself (`placedEntry`: removing or moving a link acts on the link), and in a folder that exists for a new
// entry (`placedNew`). A path is checked when it is placed; what acts on it right after opens it without following its
// last component, or acts on the entry. A concurrent change of an earlier component between the check and the act is
// a known residual race (ERNDL-1173): whoever can change the machine's files meanwhile has a shell on it already.

import { type Context, invalid } from "@earendil-works/p3/v1";
import type { FileError, Result } from "@earendil-works/p3/v1/server";
import type { MachineHost } from "../environments/contract.server.ts";
import { messages } from "./messages.ts";

/** Where `path` is on `at`, resolved through symbolic links; refused when it is relative or hidden. */
export async function placed(at: MachineHost, path: string, context: Context): Promise<string> {
	absolute(path);
	const real = must(await at.env.canonicalPath(path, context));
	if (hiddenIn(at, real)) throw hidden(real);
	return real;
}

/**
 * The entry `path` names on `at` (its folder resolved, its last component not) and its kind, for removing or moving
 * it: never the root, never in a hidden folder, never a folder holding one.
 */
export async function placedEntry(
	at: MachineHost,
	path: string,
	context: Context,
): Promise<{ readonly path: string; readonly kind: "file" | "directory" | "symlink" }> {
	const entry = await placedNew(at, path, context);
	const { kind } = must(await at.env.fileInfo(entry, context));
	if (kind === "directory") {
		for (const folder of at.hidden) if (folder.startsWith(`${entry}/`)) throw hidden(entry);
	}
	return { path: entry, kind };
}

/** Where a new entry `path` goes on `at`: its folder resolved as `placed` places it, its name as given. */
export async function placedNew(at: MachineHost, path: string, context: Context): Promise<string> {
	absolute(path);
	if (/^\/+$/.test(path)) throw invalid("args", "files: the root folder", { message: messages.message("root") });
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

/** Refuses a relative `path`. */
function absolute(path: string): void {
	if (!path.startsWith("/")) {
		throw invalid("args", `files: ${path} is not absolute`, { message: messages.message("notAbsolute") });
	}
}

/** Whether `path` (resolved) is in one of `at`'s hidden folders. */
export function hiddenIn(at: MachineHost, path: string): boolean {
	return at.hidden.some((folder) => path === folder || path.startsWith(`${folder}/`));
}

/** The refusal of a hidden path. */
function hidden(path: string) {
	return invalid("args", `files: ${path} is hidden`, { message: messages.message("hidden") });
}

/** `result`'s value, or its error as the caller sees it. */
export function must<T>(result: Result<T, FileError>): T {
	if (result.ok) return result.value;
	throw refusalOf(result.error.code, result.error.message);
}

/** A machine's failure (`code`: a `FileError`'s or a Node error's) as the caller sees it. */
export function refusalOf(code: string | undefined, reason: string) {
	if (code === "not_found" || code === "ENOENT") {
		return invalid("args", `files: ${reason}`, { message: messages.message("notFound") });
	}
	return invalid("args", `files: ${reason}`, { message: messages.message("failed", reason) });
}
