import { homedir } from "node:os";

export type ToolProjectionV1Severity = "ok" | "warning" | "error" | "info";
export type ToolProjectionV1Surface = "inline" | "dialog" | "transcript";
export type ToolProjectionV1CallTokenTone =
	| "plain"
	| "string"
	| "punctuation"
	| "number"
	| "operator"
	| "variable"
	| "function"
	| "comment";

export interface ToolProjectionV1CallToken {
	text: string;
	tone?: ToolProjectionV1CallTokenTone;
}

export interface ToolProjectionV1 {
	version: 1;
	kind?: string;
	intent?: {
		preferredSurface?: ToolProjectionV1Surface;
		priority?: number;
		dismiss?: "manual" | "auto";
	};
	call?: {
		style: "argv";
		text: string;
		command?: string;
		argv?: string[];
		cwd?: string;
		tokens?: ToolProjectionV1CallToken[];
	};
	summary?: {
		text: string;
		severity?: ToolProjectionV1Severity;
	};
	output?: {
		collapse?: {
			maxVisualLines: number;
			expandHint?: string;
		};
		format?: "text" | "markdown" | "json" | "html";
	};
	sections?: Array<{
		title: string;
		format?: "text" | "json";
		content: string;
		collapsedByDefault?: boolean;
		collapse?: { maxVisualLines: number };
	}>;
	state?: {
		title?: string;
		summary?: string;
		items?: string[];
	};
	transcript?: {
		mode?: "derive";
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function readToolProjectionV1(details: unknown): ToolProjectionV1 | undefined {
	if (!isRecord(details)) return undefined;
	const candidate = details.projection;
	if (!isRecord(candidate)) return undefined;
	if (candidate.version !== 1) return undefined;
	return candidate as unknown as ToolProjectionV1;
}

export function makeProjectionToken(text: string, tone?: ToolProjectionV1CallTokenTone): ToolProjectionV1CallToken {
	return { text, tone };
}

export function shortenPathForDisplay(path: string): string {
	const home = homedir();
	if (path.startsWith(home)) {
		return "~" + path.slice(home.length);
	}
	return path;
}

function buildPathTokens(path: string): ToolProjectionV1CallToken[] {
	return path
		.split("")
		.map((char) =>
			"/.~-_".includes(char) ? makeProjectionToken(char, "punctuation") : makeProjectionToken(char, "string"),
		);
}

function buildPatternTokens(pattern: string, wrapper?: { open: string; close: string }): ToolProjectionV1CallToken[] {
	const tokens: ToolProjectionV1CallToken[] = [];
	if (wrapper) tokens.push(makeProjectionToken(wrapper.open, "punctuation"));
	for (const char of pattern) {
		tokens.push(makeProjectionToken(char, "*?{}[]().|/\\_-".includes(char) ? "punctuation" : "string"));
	}
	if (wrapper) tokens.push(makeProjectionToken(wrapper.close, "punctuation"));
	return tokens;
}

function buildNumberTokens(value: number | string): ToolProjectionV1CallToken[] {
	return [makeProjectionToken(String(value), "number")];
}

function buildRangeTokens(offset: number, limit?: number): ToolProjectionV1CallToken[] {
	return [
		makeProjectionToken(":", "punctuation"),
		...buildNumberTokens(offset),
		...(limit !== undefined ? [makeProjectionToken("-", "punctuation"), ...buildNumberTokens(offset + limit)] : []),
	];
}

export function deriveBuiltinToolProjectionV1(
	toolName: string,
	args: Record<string, unknown>,
): ToolProjectionV1 | undefined {
	if (toolName === "read") {
		const rawPath =
			typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
		const path = shortenPathForDisplay(rawPath);
		const offset = typeof args.offset === "number" ? args.offset : undefined;
		const limit = typeof args.limit === "number" ? args.limit : undefined;
		return {
			version: 1,
			kind: "command",
			call: {
				style: "argv",
				text: path,
				tokens: [...buildPathTokens(path), ...(offset !== undefined ? buildRangeTokens(offset, limit) : [])],
			},
		};
	}
	if (toolName === "write" || toolName === "edit") {
		const rawPath =
			typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
		const path = shortenPathForDisplay(rawPath);
		const content = typeof args.content === "string" ? args.content : "";
		const lineCount = content ? content.split("\n").length : 0;
		return {
			version: 1,
			kind: "command",
			call: {
				style: "argv",
				text: path,
				tokens: [
					...buildPathTokens(path),
					...(lineCount > 0
						? [
								makeProjectionToken(" (", "punctuation"),
								...buildNumberTokens(lineCount),
								makeProjectionToken(" lines)", "string"),
							]
						: []),
				],
			},
		};
	}
	if (toolName === "glob") {
		const pattern = typeof args.pattern === "string" ? args.pattern : "";
		const path = shortenPathForDisplay(typeof args.path === "string" ? args.path : ".");
		const limit = typeof args.limit === "number" ? args.limit : undefined;
		return {
			version: 1,
			kind: "command",
			call: {
				style: "argv",
				text: pattern || path,
				tokens: [
					...(pattern ? [...buildPatternTokens(pattern), makeProjectionToken(" in ")] : []),
					...buildPathTokens(path),
					...(limit !== undefined
						? [
								makeProjectionToken(" (", "punctuation"),
								makeProjectionToken("limit ", "string"),
								...buildNumberTokens(limit),
								makeProjectionToken(")", "punctuation"),
							]
						: []),
				],
			},
		};
	}
	if (toolName === "grep") {
		const pattern = typeof args.pattern === "string" ? args.pattern : "";
		const path = shortenPathForDisplay(typeof args.path === "string" ? args.path : ".");
		const globPattern = typeof args.glob === "string" ? args.glob : "";
		const limit = typeof args.limit === "number" ? args.limit : undefined;
		return {
			version: 1,
			kind: "command",
			call: {
				style: "argv",
				text: pattern,
				tokens: [
					...buildPatternTokens(pattern, { open: "/", close: "/" }),
					makeProjectionToken(" in "),
					...buildPathTokens(path),
					...(globPattern
						? [
								makeProjectionToken(" (", "punctuation"),
								...buildPatternTokens(globPattern),
								makeProjectionToken(")", "punctuation"),
							]
						: []),
					...(limit !== undefined ? [makeProjectionToken(" limit ", "string"), ...buildNumberTokens(limit)] : []),
				],
			},
		};
	}
	if (toolName === "todo") {
		const action = typeof args.action === "string" ? args.action : "";
		return {
			version: 1,
			kind: "command",
			call: {
				style: "argv",
				text: action,
				tokens: action ? [makeProjectionToken(action, "function")] : [],
			},
		};
	}
	const argvRaw = args.argv;
	const argv = Array.isArray(argvRaw) ? argvRaw.filter((v): v is string => typeof v === "string") : [];
	if (argv.length > 0) {
		return {
			version: 1,
			kind: "command",
			call: {
				style: "argv",
				text: argv.join(" "),
				argv,
			},
		};
	}
	return undefined;
}
