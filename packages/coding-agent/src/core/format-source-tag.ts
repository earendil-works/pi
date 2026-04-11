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

function withDefault<T>(overrides: Partial<Record<SourceInfoStyle, T>>, fallback: T): Record<SourceInfoStyle, T> {
	return new Proxy({} as Record<SourceInfoStyle, T>, {
		get(_target, prop: string) {
			return overrides[prop as SourceInfoStyle] ?? fallback;
		},
	});
}

const localFormatters = withDefault<() => string | undefined>({ none: () => undefined }, () => "");

const npmFull = (s: NpmSource): string => `npm:${s.name}`;
const npmFormatters = withDefault<(s: NpmSource) => string | undefined>(
	{
		full: npmFull,
		short: npmFull,
		tiny: (s) => s.name,
		"name-only": (s) => s.name.split("/").pop()!,
		minimal: () => "",
		none: () => undefined,
	},
	npmFull,
);

const gitFull = (s: GitSource): string => `git:${s.host}/${s.path}${s.ref}`;
const gitFormatters = withDefault<(s: GitSource) => string | undefined>(
	{
		full: gitFull,
		short: (s) => `git:${s.path}${s.ref}`,
		tiny: (s) => `${s.path}${s.ref}`,
		"name-only": (s) => `${s.repo}${s.ref}`,
		minimal: () => "",
		none: () => undefined,
	},
	gitFull,
);

const sourceFormatters = {
	local: localFormatters,
	npm: npmFormatters,
	git: gitFormatters,
} as Record<ParsedSource["type"], Record<SourceInfoStyle, (s: ParsedSource) => string | undefined>>;

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
	const detail = sourceFormatters[parsed.type][style](parsed);

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
