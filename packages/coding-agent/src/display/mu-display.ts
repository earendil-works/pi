import { homedir } from "node:os";
import type { ToolResultMessage } from "@kennyfrc/mu-ai";

export type MuDisplayV1Severity = "ok" | "warning" | "error" | "info";

export type MuDisplayV1CallTokenTone =
	| "plain"
	| "string"
	| "punctuation"
	| "number"
	| "operator"
	| "variable"
	| "function"
	| "comment";

export interface MuDisplayV1CallToken {
	text: string;
	tone?: MuDisplayV1CallTokenTone;
}

export interface MuDisplayV1 {
	version: 1;
	call?: {
		style: "argv";
		text: string;
		command?: string;
		argv?: string[];
		cwd?: string;
		tokens?: MuDisplayV1CallToken[];
	};
	summary?: {
		text: string;
		severity?: MuDisplayV1Severity;
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
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function readMuDisplayV1(details: unknown): MuDisplayV1 | undefined {
	if (!isRecord(details)) return undefined;
	const candidate = details.mu_display;
	if (!isRecord(candidate)) return undefined;
	if (candidate.version !== 1) return undefined;
	return candidate as unknown as MuDisplayV1;
}

export function makeMuDisplayToken(text: string, tone?: MuDisplayV1CallTokenTone): MuDisplayV1CallToken {
	return { text, tone };
}

export function shortenPathForDisplay(path: string): string {
	const home = homedir();
	if (path.startsWith(home)) {
		return "~" + path.slice(home.length);
	}
	return path;
}

function buildPathTokens(path: string): MuDisplayV1CallToken[] {
	return path
		.split("")
		.map((char) =>
			"/.~-_".includes(char) ? makeMuDisplayToken(char, "punctuation") : makeMuDisplayToken(char, "string"),
		);
}

function buildPatternTokens(pattern: string, wrapper?: { open: string; close: string }): MuDisplayV1CallToken[] {
	const tokens: MuDisplayV1CallToken[] = [];
	if (wrapper) tokens.push(makeMuDisplayToken(wrapper.open, "punctuation"));
	for (const char of pattern) {
		tokens.push(makeMuDisplayToken(char, "*?{}[]().|/\\_-".includes(char) ? "punctuation" : "string"));
	}
	if (wrapper) tokens.push(makeMuDisplayToken(wrapper.close, "punctuation"));
	return tokens;
}

function buildNumberTokens(value: number | string): MuDisplayV1CallToken[] {
	return [makeMuDisplayToken(String(value), "number")];
}

function buildRangeTokens(offset: number, limit?: number): MuDisplayV1CallToken[] {
	return [
		makeMuDisplayToken(":", "punctuation"),
		...buildNumberTokens(offset),
		...(limit !== undefined ? [makeMuDisplayToken("-", "punctuation"), ...buildNumberTokens(offset + limit)] : []),
	];
}

export function deriveBuiltinMuDisplayV1(toolName: string, args: Record<string, unknown>): MuDisplayV1 | undefined {
	if (toolName === "read") {
		const rawPath =
			typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
		const path = shortenPathForDisplay(rawPath);
		const offset = typeof args.offset === "number" ? args.offset : undefined;
		const limit = typeof args.limit === "number" ? args.limit : undefined;
		return {
			version: 1,
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
			call: {
				style: "argv",
				text: path,
				tokens: [
					...buildPathTokens(path),
					...(lineCount > 0
						? [
								makeMuDisplayToken(" (", "punctuation"),
								...buildNumberTokens(lineCount),
								makeMuDisplayToken(" lines)", "string"),
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
			call: {
				style: "argv",
				text: pattern || path,
				tokens: [
					...(pattern ? [...buildPatternTokens(pattern), makeMuDisplayToken(" in ")] : []),
					...buildPathTokens(path),
					...(limit !== undefined
						? [
								makeMuDisplayToken(" (", "punctuation"),
								makeMuDisplayToken("limit ", "string"),
								...buildNumberTokens(limit),
								makeMuDisplayToken(")", "punctuation"),
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
			call: {
				style: "argv",
				text: pattern,
				tokens: [
					...buildPatternTokens(pattern, { open: "/", close: "/" }),
					makeMuDisplayToken(" in "),
					...buildPathTokens(path),
					...(globPattern
						? [
								makeMuDisplayToken(" (", "punctuation"),
								...buildPatternTokens(globPattern),
								makeMuDisplayToken(")", "punctuation"),
							]
						: []),
					...(limit !== undefined ? [makeMuDisplayToken(" limit ", "string"), ...buildNumberTokens(limit)] : []),
				],
			},
		};
	}
	if (toolName === "todo") {
		const action = typeof args.action === "string" ? args.action : "";
		return {
			version: 1,
			call: {
				style: "argv",
				text: action,
				tokens: action ? [makeMuDisplayToken(action, "function")] : [],
			},
		};
	}
	const argvRaw = args.argv;
	const argv = Array.isArray(argvRaw) ? argvRaw.filter((v): v is string => typeof v === "string") : [];
	if (argv.length > 0) {
		return {
			version: 1,
			call: {
				style: "argv",
				text: argv.join(" "),
				argv,
			},
		};
	}
	return undefined;
}

export function getMuDisplayFromToolResult(
	toolName: string,
	args: Record<string, unknown>,
	result?: Pick<ToolResultMessage, "details">,
): MuDisplayV1 | undefined {
	return readMuDisplayV1(result?.details) ?? deriveBuiltinMuDisplayV1(toolName, args);
}
