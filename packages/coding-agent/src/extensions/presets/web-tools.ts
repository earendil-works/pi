import { spawn as nodeSpawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import type { AgentTool } from "@kennyfrc/mu-ai";
import { type Static, Type } from "@sinclair/typebox";

import type { ExtensionApi } from "../types.js";
import { eraseAgentTool } from "../types.js";

import { runSpawnedCommand, type SpawnedProcess, type SpawnFn, type SpawnOptions } from "./spawn-cli.js";

function toTrimmedString(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.trim();
}

function defaultSpawn(command: string, args: string[], options: SpawnOptions): SpawnedProcess {
	// Node's ChildProcess type is structurally compatible with our SpawnedProcess interface.
	return nodeSpawn(command, args, options as unknown as SpawnOptionsWithoutStdio) as unknown as SpawnedProcess;
}

// ---------------------------------------------------------------------------
// web_search (websearch CLI)
// ---------------------------------------------------------------------------

export const webSearchArgsSchema = Type.Object({
	searchTerm: Type.Optional(Type.String({ description: "Positional search term (same as websearch CLI)." })),
	country: Type.Optional(Type.String({ description: "--country (two-letter code, e.g. US)" })),
	lang: Type.Optional(Type.String({ description: "--lang (language tag, e.g. en-US)" })),
	count: Type.Optional(Type.Integer({ description: "--count (number of results)" })),
	offset: Type.Optional(Type.Integer({ description: "--offset (result offset)" })),
	freshness: Type.Optional(Type.String({ description: "--freshness (e.g. d1, w1, m6)" })),
	batch: Type.Optional(Type.Array(Type.String(), { description: "--batch (repeatable queries)", minItems: 1 })),
});

export type WebSearchArgs = Static<typeof webSearchArgsSchema>;

export interface WebSearchDetails {
	command: string;
	args: string[];
	stdout: string;
	stderr: string;
}

export function createWebSearchTool(params?: {
	spawn?: SpawnFn;
	command?: string;
	cwd?: string;
}): AgentTool<typeof webSearchArgsSchema, WebSearchDetails> {
	const spawn: SpawnFn = params?.spawn ?? ((command, args, options) => defaultSpawn(command, args, options));
	const command = params?.command ?? "websearch";
	const cwd = params?.cwd;

	return {
		name: "web_search",
		label: "web_search",
		description: "Loose wrapper around the websearch CLI (Brave Search).",
		parameters: webSearchArgsSchema,
		execute: async (
			_toolCallId: string,
			args: WebSearchArgs,
			signal?: AbortSignal,
			onProgress?: (chunk: string) => void,
		) => {
			const cliArgs: string[] = ["query"];

			const searchTerm = toTrimmedString(args.searchTerm);
			if (searchTerm) {
				cliArgs.push(searchTerm);
			}

			if (args.country) cliArgs.push("--country", args.country);
			if (args.lang) cliArgs.push("--lang", args.lang);
			if (typeof args.count === "number") cliArgs.push("--count", String(args.count));
			if (typeof args.offset === "number") cliArgs.push("--offset", String(args.offset));
			if (args.freshness) cliArgs.push("--freshness", args.freshness);
			if (args.batch && args.batch.length > 0) cliArgs.push("--batch", ...args.batch);

			const res = await runSpawnedCommand({
				command,
				args: cliArgs,
				cwd,
				spawn,
				signal,
				onOutput: onProgress,
			});

			return {
				content: [{ type: "text", text: res.stdout }],
				details: {
					command,
					args: cliArgs,
					stdout: res.stdout,
					stderr: res.stderr,
				},
			};
		},
	};
}

// ---------------------------------------------------------------------------
// fetch (webfetch CLI)
// ---------------------------------------------------------------------------

export const fetchArgsSchema = Type.Object({
	url: Type.String({ description: "URL to fetch (same as webfetch CLI)." }),
	// output modes
	html: Type.Optional(Type.Boolean({ description: "--html (output raw HTML)" })),
	text: Type.Optional(Type.Boolean({ description: "--text (output plain text)" })),
	// engine
	browser: Type.Optional(Type.Boolean({ description: "--browser (render with headless browser)" })),
	// budgets/limits
	timeout: Type.Optional(Type.Integer({ description: "--timeout (ms)" })),
	userAgent: Type.Optional(Type.String({ description: "--user-agent" })),
	maxLength: Type.Optional(Type.Integer({ description: "--max-length (chars)" })),
	startIndex: Type.Optional(Type.Integer({ description: "--start-index" })),
	renderTimeout: Type.Optional(Type.Integer({ description: "--render-timeout (ms)" })),
	maxHtmlLength: Type.Optional(Type.Integer({ description: "--max-html-length (chars)" })),
	disableReadability: Type.Optional(Type.Boolean({ description: "--disable-readability" })),
	noAcceptMarkdown: Type.Optional(Type.Boolean({ description: "--no-accept-markdown" })),
	minThroughput: Type.Optional(Type.Integer({ description: "--min-throughput (bytes/sec)" })),
	throughputGrace: Type.Optional(Type.Integer({ description: "--throughput-grace (ms)" })),
	// repeatable headers
	header: Type.Optional(Type.Array(Type.String({ description: "--header key=value" }), { default: [] })),
	cookie: Type.Optional(Type.Array(Type.String({ description: "--cookie" }), { default: [] })),
	// captcha
	captchaKey: Type.Optional(Type.String({ description: "--captcha-key" })),
	captchaInterval: Type.Optional(Type.Integer({ description: "--captcha-interval (ms)" })),
	captchaReport: Type.Optional(Type.Boolean({ description: "--captcha-report" })),
	captchaSolveTimeout: Type.Optional(Type.Integer({ description: "--captcha-solve-timeout (ms)" })),
	captchaGlobalTimeout: Type.Optional(Type.Integer({ description: "--captcha-global-timeout (ms)" })),
});

export type FetchArgs = Static<typeof fetchArgsSchema>;

export interface FetchDetails {
	command: string;
	args: string[];
	stdout: string;
	stderr: string;
	nextStart?: number;
}

function parseNextStart(stderr: string): number | undefined {
	const match = /\bnext=(\d+)\b/.exec(stderr);
	if (!match) return undefined;
	const parsed = Number.parseInt(match[1], 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function createFetchTool(params?: {
	spawn?: SpawnFn;
	command?: string;
	cwd?: string;
}): AgentTool<typeof fetchArgsSchema, FetchDetails> {
	const spawn: SpawnFn = params?.spawn ?? ((command, args, options) => defaultSpawn(command, args, options));
	const command = params?.command ?? "webfetch";
	const cwd = params?.cwd;

	return {
		name: "fetch",
		label: "fetch",
		description: "Loose wrapper around the webfetch CLI (fetch a URL as Markdown/HTML/text).",
		parameters: fetchArgsSchema,
		execute: async (
			_toolCallId: string,
			args: FetchArgs,
			signal?: AbortSignal,
			onProgress?: (chunk: string) => void,
		) => {
			const cliArgs: string[] = [args.url];
			if (args.html) cliArgs.push("--html");
			if (args.text) cliArgs.push("--text");
			if (args.browser) cliArgs.push("--browser");
			if (typeof args.timeout === "number") cliArgs.push("--timeout", String(args.timeout));
			if (args.userAgent) cliArgs.push("--user-agent", args.userAgent);
			if (typeof args.maxLength === "number") cliArgs.push("--max-length", String(args.maxLength));
			if (typeof args.startIndex === "number") cliArgs.push("--start-index", String(args.startIndex));
			if (typeof args.renderTimeout === "number") cliArgs.push("--render-timeout", String(args.renderTimeout));
			if (typeof args.maxHtmlLength === "number") cliArgs.push("--max-html-length", String(args.maxHtmlLength));
			if (args.disableReadability) cliArgs.push("--disable-readability");
			if (args.noAcceptMarkdown) cliArgs.push("--no-accept-markdown");
			if (typeof args.minThroughput === "number") cliArgs.push("--min-throughput", String(args.minThroughput));
			if (typeof args.throughputGrace === "number") cliArgs.push("--throughput-grace", String(args.throughputGrace));

			for (const header of args.header ?? []) {
				const trimmed = toTrimmedString(header);
				if (trimmed) cliArgs.push("--header", trimmed);
			}
			for (const cookie of args.cookie ?? []) {
				const trimmed = toTrimmedString(cookie);
				if (trimmed) cliArgs.push("--cookie", trimmed);
			}

			if (args.captchaKey) cliArgs.push("--captcha-key", args.captchaKey);
			if (typeof args.captchaInterval === "number") cliArgs.push("--captcha-interval", String(args.captchaInterval));
			if (args.captchaReport) cliArgs.push("--captcha-report");
			if (typeof args.captchaSolveTimeout === "number")
				cliArgs.push("--captcha-solve-timeout", String(args.captchaSolveTimeout));
			if (typeof args.captchaGlobalTimeout === "number")
				cliArgs.push("--captcha-global-timeout", String(args.captchaGlobalTimeout));

			const res = await runSpawnedCommand({
				command,
				args: cliArgs,
				cwd,
				spawn,
				signal,
				onOutput: onProgress,
			});

			return {
				content: [{ type: "text", text: res.stdout }],
				details: {
					command,
					args: cliArgs,
					stdout: res.stdout,
					stderr: res.stderr,
					nextStart: parseNextStart(res.stderr),
				},
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Extension factory (default export)
// ---------------------------------------------------------------------------

export default function webToolsExtension(mu: ExtensionApi): void {
	mu.registerTool(eraseAgentTool(createWebSearchTool()));
	mu.registerTool(eraseAgentTool(createFetchTool()));
}
