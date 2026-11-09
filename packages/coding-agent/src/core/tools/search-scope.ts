// Resolve local search roots, globs, exclusions, and grep line selectors once for both tools.
import { lstat, stat } from "node:fs/promises";
import path from "node:path";
import type { SearchTarget } from "../../utils/native-search.ts";
import { resolveToCwd } from "./path-utils.ts";

export interface SearchScope {
	targets: SearchTarget[];
	exclusions: string[];
	missingPaths: string[];
	basePath: string;
	singleFile: boolean;
}

/** Resolve explicit scopes without walking a common ancestor or searching unrelated siblings. */
export async function resolveSearchScope(
	cwd: string,
	input: string | undefined,
	kind: "grep" | "find",
): Promise<SearchScope> {
	const entries = input?.split(";").map((entry) => entry.trim()) ?? ["."];
	if (entries.some((entry) => !entry)) throw new Error("Search scope entries must be non-empty paths or globs");
	const targets: SearchTarget[] = [];
	const exclusions: string[] = [];
	const missingPaths: string[] = [];
	let singleFile = false;
	for (const entry of entries) {
		let absolute = resolveToCwd(entry, cwd);
		const exact = await searchStat(absolute, kind);
		if (!exact && entry.startsWith("!")) {
			const pattern = entry.slice(1).split(path.sep).join("/");
			if (!pattern) throw new Error("Exclusion glob must not be empty");
			if (pattern.includes("/")) {
				const absolutePattern = resolveToCwd(pattern, cwd);
				const { root } = await resolveGlobRoot(absolutePattern, kind);
				const prefix = root
					.split(path.sep)
					.join("/")
					.replace(/[*?{}[\]]/g, "[$&]");
				exclusions.push(
					`${prefix}${prefix.endsWith("/") ? "" : "/"}${path.relative(root, absolutePattern).split(path.sep).join("/")}`,
				);
			} else {
				exclusions.push(`**/${pattern}`);
			}
			continue;
		}
		let ranges: SearchTarget["ranges"] = [];
		if (!exact && kind === "grep") {
			const selector = /:((?:\d+(?:[-+]\d*)?)(?:,\d+(?:[-+]\d*)?)*)$/.exec(entry);
			if (selector) {
				absolute = resolveToCwd(entry.slice(0, selector.index), cwd);
				ranges = selector[1].split(",").map((part) => {
					const [startText, endText] = part.split(/[-+]/);
					const start = Number(startText);
					const end = part.includes("+") ? start + Number(endText) - 1 : endText ? Number(endText) : 0xffffffff;
					if (
						!Number.isSafeInteger(start) ||
						start < 1 ||
						!Number.isSafeInteger(end) ||
						end < start ||
						end > 0xffffffff
					) {
						throw new Error(`Invalid line range: ${part}`);
					}
					return { start, end };
				});
			}
		}
		const metadata = exact ?? (await searchStat(absolute, kind));
		if (metadata) {
			if (ranges.length && !metadata.isFile())
				throw new Error(`Line-range selector requires a single file: ${entry}`);
			const previous = targets.find((target) => target.path === absolute && target.glob === undefined);
			if (previous) {
				previous.ranges = previous.ranges.length && ranges.length ? [...previous.ranges, ...ranges] : [];
			} else {
				targets.push({ path: absolute, ranges });
			}
			singleFile = metadata.isFile() || (kind === "find" && metadata.isSymbolicLink());
			continue;
		}
		if (ranges.length) throw new Error(`Path not found for line-range selector: ${entry}`);
		// Existing directory components are literal, including glob characters in cwd or parent names.
		const { root, metadata: base } = await resolveGlobRoot(absolute, kind);
		let glob = path.relative(root, absolute).split(path.sep).join("/");
		if (!base || !/[*?{[]/.test(glob.split("/")[0])) {
			missingPaths.push(entry);
			continue;
		}
		if (!base.isDirectory()) throw new Error(`Not a directory: ${root}`);
		// A bare basename glob searches recursively; an explicit directory prefix fixes its depth.
		if (!entry.split(path.sep).join("/").includes("/")) glob = `**/${glob}`;
		targets.push({ path: root, glob, ranges });
		singleFile = false;
	}
	if (!targets.length && exclusions.length && !missingPaths.length) targets.push({ path: cwd, ranges: [] });
	if (!targets.length) throw new Error(`Path not found: ${missingPaths.join("; ")}`);
	targets.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return {
		targets,
		exclusions,
		missingPaths,
		basePath: targets.length === 1 ? targets[0].path : cwd,
		singleFile: targets.length === 1 && singleFile,
	};
}

/** Make filename-only filters recursive while preserving explicit directory depth. */
export function recursiveBasenameGlob(pattern: string): string {
	const normalized = pattern.split(path.sep).join("/");
	return normalized.includes("/") ? normalized : `**/${normalized}`;
}

/** Render paths relative to the search scope, preserving directory markers and cross-volume identities. */
export function searchResultPath(file: string, base: string): string {
	const relative = path.relative(base, file);
	return (
		(relative || path.basename(file)).split(path.sep).join("/") +
		(file.endsWith("/") && !relative.endsWith(path.sep) ? "/" : "")
	);
}

async function searchStat(file: string, kind: "grep" | "find") {
	try {
		return await stat(file);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
		if (kind === "grep") return undefined;
	}
	// Filename discovery still sees a dangling link when following its target fails.
	try {
		return await lstat(file);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		throw error;
	}
}

async function resolveGlobRoot(file: string, kind: "grep" | "find") {
	let root = path.dirname(file);
	let metadata = await searchStat(root, kind);
	while (!metadata?.isDirectory() && path.dirname(root) !== root) {
		root = path.dirname(root);
		metadata = await searchStat(root, kind);
	}
	return { root, metadata };
}
