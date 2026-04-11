import { parseGitUrl } from "../utils/git.js";
import type { SourceInfo } from "./source-info.js";

export type SourceInfoStyle = "full" | "short" | "tiny" | "name-only" | "minimal" | "none";

interface NpmSource {
	type: "npm";
	name: string;
}

interface GitSource {
	type: "git";
	host: string;
	path: string;
	repo: string;
	ref: string;
}

type ParsedSource = { type: "local" } | NpmSource | GitSource;

const scopePrefixes: Record<SourceInfo["scope"], string> = {
	user: "u",
	project: "p",
	temporary: "t",
};

const localFormatters: Record<SourceInfoStyle, () => string | undefined> = {
	none: () => undefined,
	minimal: () => "",
	"name-only": () => "",
	tiny: () => "",
	short: () => "",
	full: () => "",
};

const npmFormatters: Record<SourceInfoStyle, (s: NpmSource) => string | undefined> = {
	none: () => undefined,
	minimal: () => "",
	"name-only": (s) => s.name.split("/").pop()!,
	tiny: (s) => s.name,
	short: (s) => `npm:${s.name}`,
	full: (s) => `npm:${s.name}`,
};

const gitFormatters: Record<SourceInfoStyle, (s: GitSource) => string | undefined> = {
	none: () => undefined,
	minimal: () => "",
	"name-only": (s) => `${s.repo}${s.ref}`,
	tiny: (s) => `${s.path}${s.ref}`,
	short: (s) => `git:${s.path}${s.ref}`,
	full: (s) => `git:${s.host}/${s.path}${s.ref}`,
};

function parseSource(raw: string): ParsedSource {
	const source = raw.trim();

	if (source.startsWith("npm:")) {
		return { type: "npm", name: source.slice(4) };
	}

	const gitSource = parseGitUrl(source);
	if (gitSource) {
		return {
			type: "git",
			host: gitSource.host,
			path: gitSource.path,
			repo: gitSource.path.split("/").pop() ?? gitSource.path,
			ref: gitSource.ref ? `@${gitSource.ref}` : "",
		};
	}

	return { type: "local" };
}

export function formatSourceTag(sourceInfo: SourceInfo, style: SourceInfoStyle): string | undefined {
	const prefix = scopePrefixes[sourceInfo.scope];
	const parsed = parseSource(sourceInfo.source);

	const detail =
		parsed.type === "npm"
			? npmFormatters[style](parsed)
			: parsed.type === "git"
				? gitFormatters[style](parsed)
				: localFormatters[style]();

	if (detail === undefined) return undefined;
	return detail ? `${prefix}:${detail}` : prefix;
}

export function prefixAutocompleteDescription(
	description: string | undefined,
	sourceInfo: SourceInfo | undefined,
	style: SourceInfoStyle,
): string | undefined {
	if (!sourceInfo) {
		return description;
	}
	const sourceTag = formatSourceTag(sourceInfo, style);
	if (!sourceTag) {
		return description;
	}
	return description ? `[${sourceTag}] ${description}` : `[${sourceTag}]`;
}
