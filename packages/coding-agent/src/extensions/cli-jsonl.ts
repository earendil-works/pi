import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn as nodeSpawn, type SpawnOptionsWithoutStdio } from "node:child_process";

export type CliProgressMode = "stderr" | "stdout" | "both" | "none";

export interface RunJsonlCliCommandParams {
	command: string;
	args: string[];
	cwd?: string;
	env?: Record<string, string>;
	stdin?: string;
	progress?: CliProgressMode;
	signal?: AbortSignal;
	onProgress?: (chunk: string) => void;
}

export interface RunJsonlCliCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type MuDisplayV1Severity = "ok" | "warning" | "error" | "info";

export interface MuDisplayV1 {
	version: 1;
	call?: {
		style: "argv";
		text: string;
		command: string;
		argv: string[];
		cwd?: string;
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

function defaultSpawn(
	command: string,
	args: string[],
	options: SpawnOptionsWithoutStdio,
): ChildProcessWithoutNullStreams {
	return nodeSpawn(command, args, options) as ChildProcessWithoutNullStreams;
}

export async function runJsonlCliCommand(params: RunJsonlCliCommandParams): Promise<RunJsonlCliCommandResult> {
	const progressMode: CliProgressMode = params.progress ?? "stderr";

	const child = defaultSpawn(params.command, params.args, {
		cwd: params.cwd,
		stdio: ["pipe", "pipe", "pipe"],
		env: {
			...process.env,
			...params.env,
		},
		shell: false,
	} satisfies SpawnOptionsWithoutStdio);

	let stdout = "";
	let stderr = "";

	const onStdoutChunk = (buf: Buffer) => {
		const text = buf.toString("utf8");
		stdout += text;
		if ((progressMode === "stdout" || progressMode === "both") && params.onProgress) {
			params.onProgress(text);
		}
	};

	const onStderrChunk = (buf: Buffer) => {
		const text = buf.toString("utf8");
		stderr += text;
		if ((progressMode === "stderr" || progressMode === "both") && params.onProgress) {
			params.onProgress(text);
		}
	};

	child.stdout.on("data", onStdoutChunk);
	child.stderr.on("data", onStderrChunk);

	if (typeof params.stdin === "string") {
		child.stdin.write(params.stdin);
		child.stdin.end();
	} else {
		child.stdin.end();
	}

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

	return { exitCode, stdout, stderr };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function parseJsonl(stdout: string, synthToolName?: string): unknown[] {
	const records: unknown[] = [];

	const lines = stdout.split(/\r?\n/);
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) continue;

		try {
			records.push(JSON.parse(line) as unknown);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			records.push({
				type: "error",
				tool: synthToolName,
				kind: "jsonl_parse_error",
				message,
				line,
				ts: Date.now(),
			});
		}
	}

	return records;
}

export function deriveContentFromJsonlRecords(records: unknown[]): string {
	const chunks: string[] = [];

	for (const record of records) {
		if (!isRecord(record)) continue;
		if (record.type !== "output") continue;
		const content = record.content;
		if (typeof content !== "string") continue;
		chunks.push(content);
	}

	if (chunks.length > 0) {
		return chunks.join("");
	}

	return JSON.stringify(records, null, 2);
}

export function deriveOkFromJsonlRecords(records: unknown[]): boolean | undefined {
	for (const record of records) {
		if (!isRecord(record)) continue;
		if (record.type !== "result") continue;
		const ok = record.ok;
		if (typeof ok === "boolean") return ok;
	}
	return undefined;
}

function quoteArgForDisplay(arg: string): string {
	// Unquoted if it's a simple token (no whitespace, no shell-ish punctuation)
	if (/^[A-Za-z0-9._/:=-]+$/.test(arg)) return arg;
	return JSON.stringify(arg);
}

export function formatCommandLineForDisplay(command: string, argv: string[]): string {
	const parts = [command, ...argv].map((p) => quoteArgForDisplay(p));
	return parts.join(" ").trim();
}

function lastResultRecord(records: unknown[]): Record<string, unknown> | undefined {
	for (let i = records.length - 1; i >= 0; i--) {
		const rec = records[i];
		if (!isRecord(rec)) continue;
		if (rec.type === "result") return rec;
	}
	return undefined;
}

function formatSummaryFromResultSummary(summary: unknown): string | undefined {
	if (!isRecord(summary)) return undefined;

	// webfetch-style
	const source = summary.source;
	if (isRecord(source)) {
		const cached = typeof source.cached === "boolean" ? source.cached : undefined;
		const engine = typeof source.engine === "string" ? source.engine : undefined;
		const status = typeof source.statusCode === "number" ? source.statusCode : undefined;

		const parts: string[] = [];
		if (cached !== undefined) parts.push(cached ? "HIT" : "MISS");
		if (engine) parts.push(engine.toUpperCase());
		if (status !== undefined) parts.push(String(status));

		const chunk = summary.chunk;
		if (isRecord(chunk)) {
			const truncated = typeof chunk.truncated === "boolean" ? chunk.truncated : undefined;
			const nextStart = chunk.nextStart;
			if (truncated) parts.push("truncated");
			if (typeof nextStart === "number") parts.push(`next=${nextStart}`);
		}

		if (parts.length > 0) return parts.join(" · ");
	}

	// websearch-style per query
	const results = summary.results;
	if (Array.isArray(results)) {
		return `results=${results.length}`;
	}

	// websearch run summary
	const queries = summary.queries;
	const failed = summary.failed;
	if (typeof queries === "number" || typeof failed === "number") {
		const parts: string[] = [];
		if (typeof queries === "number") parts.push(`queries=${queries}`);
		if (typeof failed === "number") parts.push(`failed=${failed}`);
		return parts.join(" · ");
	}

	return undefined;
}

export function buildMuDisplayV1ForCliResult(args: {
	toolName: string;
	command: string;
	displayArgv: string[];
	cwd?: string;
	exitCode: number;
	ok: boolean;
	records: unknown[];
	stderr: string;
}): MuDisplayV1 {
	const callText = formatCommandLineForDisplay(args.command, args.displayArgv);

	const resultRec = lastResultRecord(args.records);
	const summaryTextFromResult = resultRec ? formatSummaryFromResultSummary(resultRec.summary) : undefined;
	const base = `${args.ok ? "ok" : "error"} · exit=${args.exitCode}`;
	const summaryText = summaryTextFromResult ? `${base} · ${summaryTextFromResult}` : base;

	const sections: MuDisplayV1["sections"] = [];
	if (args.stderr.trim()) {
		sections.push({
			title: "stderr",
			format: "text",
			content: args.stderr.trimEnd(),
			collapsedByDefault: true,
			collapse: { maxVisualLines: 6 },
		});
	}

	return {
		version: 1,
		call: {
			style: "argv",
			text: callText,
			command: args.command,
			argv: args.displayArgv,
			cwd: args.cwd,
		},
		summary: {
			text: summaryText,
			severity: args.ok ? "ok" : "error",
		},
		output: {
			collapse: { maxVisualLines: 5, expandHint: "ctrl+o to expand" },
		},
		sections: sections.length > 0 ? sections : undefined,
	};
}
