import type { SourceInfo } from "./source-info.js";
import { parseGitUrl } from "../utils/git.js";

export type SourceInfoStyle = "full" | "short" | "tiny" | "name-only" | "minimal" | "none";

export function formatSourceTag(sourceInfo: SourceInfo, style: SourceInfoStyle): string | undefined {
	if (style === "none") {
		return undefined;
	}

	const scopePrefix = sourceInfo.scope === "user" ? "u" : sourceInfo.scope === "project" ? "p" : "t";

	if (style === "minimal") {
		return scopePrefix;
	}

	const source = sourceInfo.source.trim();

	if (source === "auto" || source === "local" || source === "cli") {
		return scopePrefix;
	}

	if (source.startsWith("npm:")) {
		const npmName = source.slice(4);
		switch (style) {
			case "name-only":
				return `${scopePrefix}:${npmName.split("/").pop()}`;
			case "tiny":
				return `${scopePrefix}:${npmName}`;
			case "short":
			case "full":
			default:
				return `${scopePrefix}:${source}`;
		}
	}

	const gitSource = parseGitUrl(source);
	if (gitSource) {
		const ref = gitSource.ref ? `@${gitSource.ref}` : "";
		const repoName = gitSource.path.split("/").pop() ?? gitSource.path;
		switch (style) {
			case "name-only":
				return `${scopePrefix}:${repoName}${ref}`;
			case "tiny":
				return `${scopePrefix}:${gitSource.path}${ref}`;
			case "short":
				return `${scopePrefix}:git:${gitSource.path}${ref}`;
			case "full":
			default:
				return `${scopePrefix}:git:${gitSource.host}/${gitSource.path}${ref}`;
		}
	}

	return scopePrefix;
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
