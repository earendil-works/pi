import { spawn as nodeSpawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { AgentTool } from "@kennyfrc/mu-ai";
import { type Static, type TSchema, Type } from "@sinclair/typebox";

interface SpawnedProcess {
	stdout: Readable;
	stderr: Readable;
	on(event: "close", handler: (code: number | null) => void): this;
	on(event: "error", handler: (err: Error) => void): this;
	kill(signal?: NodeJS.Signals | number): boolean;
}

interface SpawnOptions {
	cwd?: string;
	stdio: ["ignore", "pipe", "pipe"];
}

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => SpawnedProcess;

interface RunSpawnedCommandParams {
	command: string;
	args: string[];
	spawn: SpawnFn;
	cwd?: string;
	signal?: AbortSignal;
	onOutput?: (chunk: string) => void;
}

interface SpawnedCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	combined: string;
}

async function runSpawnedCommand(params: RunSpawnedCommandParams): Promise<SpawnedCommandResult> {
	const child = params.spawn(params.command, params.args, {
		cwd: params.cwd,
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";
	let combined = "";

	const append = (kind: "stdout" | "stderr", chunk: Buffer) => {
		const text = chunk.toString("utf8");
		combined += text;
		if (kind === "stdout") {
			stdout += text;
		} else {
			stderr += text;
		}
		params.onOutput?.(text);
	};

	child.stdout.on("data", (d: Buffer) => append("stdout", d));
	child.stderr.on("data", (d: Buffer) => append("stderr", d));

	const abort = () => {
		child.kill("SIGKILL");
	};

	if (params.signal) {
		if (params.signal.aborted) {
			abort();
		} else {
			params.signal.addEventListener("abort", abort, { once: true });
		}
	}

	const exitCode = await new Promise<number>((resolve, reject) => {
		child.on("error", (err) => reject(err));
		child.on("close", (code) => resolve(code ?? 0));
	});

	if (params.signal) {
		params.signal.removeEventListener("abort", abort);
	}

	if (exitCode !== 0) {
		throw new Error(
			`Command failed with exit code ${exitCode}: ${params.command} ${params.args.join(" ")}\n\n${combined}`.trim(),
		);
	}

	return { exitCode, stdout, stderr, combined };
}

interface ExtensionApiLike {
	registerTool(tool: AgentTool<TSchema, unknown>): void;
}

function eraseTool<TParams extends TSchema, TDetails>(tool: AgentTool<TParams, TDetails>): AgentTool<TSchema, unknown> {
	return tool as unknown as AgentTool<TSchema, unknown>;
}

function toTrimmedString(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.trim();
}

type ToolProjectionV1Severity = "ok" | "warning" | "error" | "info";

interface ToolProjectionV1 {
	version: 1;
	call?: {
		style: "argv";
		text: string;
		command?: string;
		argv?: string[];
		cwd?: string;
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
}

function quoteArgForDisplay(arg: string): string {
	if (/^[A-Za-z0-9._/:=-]+$/.test(arg)) return arg;
	return JSON.stringify(arg);
}

function formatCommandLineForDisplay(command: string, argv: string[]): string {
	return [command, ...argv]
		.map((p) => quoteArgForDisplay(p))
		.join(" ")
		.trim();
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
	projection?: ToolProjectionV1;
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
					projection: {
						version: 1,
						call: {
							style: "argv",
							text: formatCommandLineForDisplay(command, cliArgs),
							command,
							argv: cliArgs,
							cwd,
						},
						summary: { text: "ok · exit=0", severity: "ok" },
						output: { collapse: { maxVisualLines: 5, expandHint: "ctrl+o to expand" } },
					},
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
	projection?: ToolProjectionV1;
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

			const nextStart = parseNextStart(res.stderr);
			const summary = nextStart === undefined ? "ok · exit=0" : `ok · exit=0 · next=${nextStart}`;

			return {
				content: [{ type: "text", text: res.stdout }],
				details: {
					command,
					args: cliArgs,
					stdout: res.stdout,
					stderr: res.stderr,
					nextStart,
					projection: {
						version: 1,
						call: {
							style: "argv",
							text: formatCommandLineForDisplay(command, cliArgs),
							command,
							argv: cliArgs,
							cwd,
						},
						summary: { text: summary, severity: "ok" },
						output: { collapse: { maxVisualLines: 5, expandHint: "ctrl+o to expand" } },
					},
				},
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Extension factory (default export)
// ---------------------------------------------------------------------------

export default function webToolsExtension(mu: ExtensionApiLike): void {
	mu.registerTool(eraseTool(createWebSearchTool()));
	mu.registerTool(eraseTool(createFetchTool()));
}
