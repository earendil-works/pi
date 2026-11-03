import type { Static } from "@earendil-works/pi-schema";
import type { Location } from "@p2/app/v1";
import type { QuerySchema, WriteSchema } from "./contract.ts";

// Workspace panel protocol: read-only views of a conversation's working directory,
// always resolved inside that conversation's execution environment by its worker.
/** The types of the contract's schemas (contract.ts). */
export type WorkspaceQuery = Static<typeof QuerySchema>;
export type WorkspaceUpload = Static<typeof WriteSchema>;
export type WorkspaceEntry = {
	name: string;
	kind: "file" | "directory" | "symlink";
	size: number;
	mtimeMs: number;
	/** Matched by .gitignore (not reported for tracked files or outside a repository). */
	ignored?: boolean;
};
export type WorkspaceMatch = { path: string; line: number; text: string };
export type WorkspaceCommit = {
	hash: string;
	short: string;
	author: string;
	/** Commit time in milliseconds. */
	time: number;
	subject: string;
	/** Not on the upstream branch yet; absent when the branch has no upstream. */
	unpushed?: boolean;
};
export type WorkspaceChange = {
	path: string;
	/** Porcelain v2 XY status: index then worktree; `??` untracked, `U` letters for conflicts. */
	status: string;
	from?: string;
};
export type WorkspaceResult =
	| { kind: "list"; path: string; entries: WorkspaceEntry[]; truncated: boolean }
	| { kind: "file"; path: string; size: number; binary: boolean; text?: string; truncated: boolean }
	| { kind: "status"; repo: false; reason?: string }
	| { kind: "status"; repo: true; branch?: string; head?: string; changes: WorkspaceChange[]; truncated: boolean }
	| { kind: "diff"; path: string; full: boolean; patch: string; truncated: boolean }
	| { kind: "search"; text: string; path: string; matches: WorkspaceMatch[]; truncated: boolean }
	| { kind: "files"; paths: string[]; truncated: boolean }
	| { kind: "log"; commits: WorkspaceCommit[]; more: boolean; upstream?: string }
	| {
			kind: "place";
			/** Where the workspace is open: the conversation's location as its worker resolved it. */
			location: Location;
			/** The session's move waiting for the main agent's turn to end. */
			pending?: Location;
			/** The session's last move that failed (cleared by the next one). */
			failed?: { to: Location; error: string };
	  }
	| {
			kind: "commit";
			commit: string;
			author: string;
			time: number;
			message: string;
			changes: WorkspaceChange[];
			truncated: boolean;
	  };
/** A bounded byte range of one workspace file, transferred over IPC as base64. */
export type WorkspaceBytes = { size: number; start: number; data: string };

export const WORKSPACE_TEXT_LIMIT = 1024 * 1024;
export const WORKSPACE_READ_CHUNK = 1024 * 1024;
export const WORKSPACE_DOWNLOAD_LIMIT = 25 * 1024 * 1024;

/** Search text: 1-200 characters on one line. */
export function workspaceSearchText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() && value.length <= 200 && !/[\0\r\n]/.test(value)
		? value
		: undefined;
}

/**
 * VS Code-style file globs, comma-separated: `*.ts, src/`, `*.{ts,tsx}`. Braces expand;
 * a pattern matches at any depth unless it starts with `./` or `/`. Returns normalized
 * git glob patterns (`**\/*.ts`); callers also match everything below a matching folder.
 * Undefined when invalid: control characters, backslashes, `..` segments, unbalanced
 * braces, over 500 characters or 32 expanded patterns. `""` is no patterns.
 */
export function workspaceGlobs(value: unknown): string[] | undefined {
	if (typeof value !== "string" || value.length > 500 || value.includes("\\")) return undefined;
	if ([...value].some((char) => char < " ")) return undefined;
	const patterns: string[] = [];
	// Expands the first brace group of each pattern until none is left.
	const expand = (pattern: string): boolean => {
		const open = pattern.indexOf("{");
		if (open < 0) {
			if (pattern.includes("}")) return false;
			patterns.push(pattern);
			return patterns.length <= 32;
		}
		const parts: string[] = [];
		let depth = 0;
		let start = open + 1;
		for (let index = open; index < pattern.length; index++) {
			const char = pattern[index];
			if (char === "{") depth++;
			else if (char === "," && depth === 1) {
				parts.push(pattern.slice(start, index));
				start = index + 1;
			} else if (char === "}" && --depth === 0) {
				parts.push(pattern.slice(start, index));
				const rest = pattern.slice(index + 1);
				return parts.every((part) => expand(`${pattern.slice(0, open)}${part}${rest}`));
			}
		}
		return false;
	};
	// Commas inside braces belong to the brace group, not the list.
	let depth = 0;
	let start = 0;
	for (let index = 0; index <= value.length; index++) {
		const char = value[index];
		if (char === "{") depth++;
		else if (char === "}") depth--;
		else if (index === value.length || (char === "," && depth === 0)) {
			const pattern = value.slice(start, index).trim();
			start = index + 1;
			if (pattern && !expand(pattern)) return undefined;
		}
	}
	const normalized: string[] = [];
	for (const pattern of patterns) {
		const anchored = pattern.startsWith("/") || pattern.startsWith("./");
		const segments = pattern.split("/").filter((segment) => segment && segment !== ".");
		if (segments.includes("..")) return undefined;
		if (!segments.length) continue;
		const glob = segments.join("/");
		normalized.push(anchored || glob === "**" || glob.startsWith("**/") ? glob : `**/${glob}`);
	}
	return [...new Set(normalized)];
}

export { workspacePath } from "./contract.ts";
