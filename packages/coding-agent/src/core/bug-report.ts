import * as os from "node:os";
import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { contentText, normalizeContext, type RetryPolicy, uuidv7 } from "@earendil-works/pi-ai";
import type { Api, Model, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { VERSION } from "../config.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { writeZipArchive } from "../utils/zip.ts";
import { completeSummarization, estimateTokens, getSummarizationFailure } from "./compaction/compaction.ts";
import { serializeConversation } from "./compaction/utils.ts";
import type { CrashRecord } from "./crash-log.ts";
import type { Extension } from "./extensions/types.ts";
import { convertToLlm } from "./messages.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { ReadonlySessionManager } from "./session-manager.ts";
import type { Settings } from "./settings-manager.ts";

export const BUG_REPORT_CUSTOM_ENTRY_TYPE = "pi.bug-report";
const BUG_REPORT_SCHEMA_VERSION = 1;
const REDACTED = "<redacted>";
const SENSITIVE_KEY = /(?:^|[-_])(api[-_]?key|secret|token|password|passwd|credential|authorization|cookie)(?:$|[-_])/i;

function isSensitiveKey(key: string): boolean {
	return SENSITIVE_KEY.test(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
}

/** Strip credentials and secret-looking query parameters from a URL. */
export function redactUrl(value: string): string {
	const nested = /^([a-z][a-z0-9+.-]*:)([a-z][a-z0-9+.-]*:\/\/.*)$/i.exec(value);
	if (nested) return `${nested[1]}${redactUrl(nested[2])}`;
	try {
		const url = new URL(value);
		let changed = false;
		if (url.username || url.password) {
			url.username = "";
			url.password = "";
			changed = true;
		}
		for (const key of url.searchParams.keys()) {
			if (isSensitiveKey(key)) {
				url.searchParams.set(key, REDACTED);
				changed = true;
			}
		}
		return changed ? url.toString() : value;
	} catch {
		return value;
	}
}

/** Copy a JSON value while removing values that may contain credentials. */
export function redactJsonValue(value: unknown): unknown {
	if (value === undefined) return undefined;
	return JSON.parse(
		JSON.stringify(value, (key, child: unknown) => {
			if (child !== null && child !== undefined && isSensitiveKey(key)) return REDACTED;
			return typeof child === "string" ? redactUrl(child) : child;
		}),
	);
}

function redactSettings(settings: Settings): Settings {
	const { trackingId: _trackingId, ...rest } = settings;
	return redactJsonValue(rest) as Settings;
}

function collectEnvironment() {
	const env = (name: string): string | null => process.env[name] || null;
	return {
		version: VERSION,
		userAgent: getPiUserAgent(VERSION),
		runtime: process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`,
		platform: process.platform,
		arch: process.arch,
		osRelease: os.release(),
		osVersion: os.version(),
		shell: process.env.SHELL?.split(/[\\/]/).pop() || null,
		terminal: {
			term: env("TERM"),
			program: env("TERM_PROGRAM"),
			programVersion: env("TERM_PROGRAM_VERSION"),
			colorterm: env("COLORTERM"),
			tmux: Boolean(process.env.TMUX),
			ssh: Boolean(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY),
			ci: Boolean(process.env.CI),
		},
		// Names help diagnose configuration; values never leave the machine.
		piEnvironmentVariables: Object.keys(process.env)
			.filter((name) => name.startsWith("PI_"))
			.sort(),
	};
}

function describeModel(model: Model<Api>) {
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
		api: model.api,
		baseUrl: redactUrl(model.baseUrl),
		reasoning: model.reasoning,
		input: model.input,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		samplingParams: model.samplingParams ? redactJsonValue(model.samplingParams) : null,
		compat: model.compat ? redactJsonValue(model.compat) : null,
		thinkingLevelMap: model.thinkingLevelMap ?? null,
		headerNames: Object.keys(model.headers ?? {}).sort(),
	};
}

function describeProvider(modelRuntime: ModelRuntime, provider: Provider) {
	const authTypes: Array<"api_key" | "oauth"> = [];
	if (provider.auth.apiKey) authTypes.push("api_key");
	if (provider.auth.oauth) authTypes.push("oauth");
	return {
		id: provider.id,
		name: provider.name,
		baseUrl: provider.baseUrl ? redactUrl(provider.baseUrl) : null,
		headerNames: Object.keys(provider.headers ?? {}).sort(),
		authTypes,
		authStatus: modelRuntime.getProviderAuthStatus(provider.id),
		usingOAuth: modelRuntime.isUsingOAuth(provider.id),
		registeredByExtension: modelRuntime.getRegisteredProviderIds().includes(provider.id),
	};
}

function describeExtension(extension: Extension) {
	return {
		path: extension.path,
		source: redactUrl(extension.sourceInfo.source),
		scope: extension.sourceInfo.scope,
		origin: extension.sourceInfo.origin,
		hidden: extension.hidden === true,
	};
}

interface CollectBugReportMetadataOptions {
	id?: string;
	hint?: string;
	sessionId: string;
	cwd: string;
	includeSession: boolean;
	includeSummary: boolean;
	messageCount: number;
	model?: Model<Api>;
	modelRuntime: ModelRuntime;
	thinkingLevel: ThinkingLevel;
	extensions: readonly Extension[];
	extensionErrors: ReadonlyArray<{ path: string; error: string }>;
	globalSettings: Settings;
	projectSettings: Settings;
}

export function collectBugReportMetadata(options: CollectBugReportMetadataOptions) {
	const hint = options.hint?.trim() || null;
	const provider = options.model ? options.modelRuntime.getProvider(options.model.provider) : undefined;
	return {
		schemaVersion: BUG_REPORT_SCHEMA_VERSION,
		id: options.id ?? uuidv7(),
		createdAt: new Date().toISOString(),
		hint,
		environment: collectEnvironment(),
		session: {
			id: options.sessionId,
			included: options.includeSession,
			summaryIncluded: options.includeSummary,
			messageCount: options.messageCount,
			...(options.includeSession ? { cwd: options.cwd } : {}),
		},
		model: options.model ? describeModel(options.model) : null,
		provider: provider ? describeProvider(options.modelRuntime, provider) : null,
		thinkingLevel: options.thinkingLevel,
		extensions: options.extensions.map(describeExtension),
		extensionErrors: options.extensionErrors.map(({ path, error }) => ({ path, error })),
		settings: {
			global: redactSettings(options.globalSettings),
			project: redactSettings(options.projectSettings),
		},
	};
}

/** Collect failed assistant turns without collecting conversation content. */
export function collectBugReportDiagnostics(
	sessionManager: ReadonlySessionManager,
	crashes: readonly CrashRecord[] = [],
) {
	const entries = sessionManager.getEntries();
	const assistant = [];
	let assistantMessageCount = 0;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		assistantMessageCount++;
		const message = entry.message;
		const diagnostics = message.diagnostics ?? [];
		if (
			diagnostics.length === 0 &&
			message.stopReason !== "error" &&
			message.stopReason !== "aborted" &&
			!message.errorMessage
		) {
			continue;
		}
		assistant.push({
			entryId: entry.id,
			timestamp: entry.timestamp,
			provider: message.provider,
			model: message.model,
			api: message.api,
			stopReason: message.stopReason,
			...(message.rawStopReason === undefined ? {} : { rawStopReason: message.rawStopReason }),
			...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
			diagnostics,
		});
	}
	return {
		schemaVersion: BUG_REPORT_SCHEMA_VERSION,
		sessionId: sessionManager.getSessionId(),
		entryCount: entries.length,
		assistantMessageCount,
		assistant,
		crashes: crashes.map(({ notified: _notified, ...record }) => record),
	};
}

export type BugReportMetadata = ReturnType<typeof collectBugReportMetadata>;
export type BugReportDiagnostics = ReturnType<typeof collectBugReportDiagnostics>;

export interface BugReportBundle {
	metadata: BugReportMetadata;
	diagnostics: BugReportDiagnostics;
	sessionJsonl?: string;
	summary?: string;
}

export interface BugReportSessionEntryData {
	id: string;
	createdAt: string;
	hint: string | null;
	sessionIncluded: boolean;
	summaryIncluded: boolean;
	delivery: "zip" | "upload";
	path?: string;
}

interface BugReportFile {
	name: string;
	contentType: string;
	data: string;
}

/** Files shared by upload and zip export. */
export function bugReportFiles(bundle: BugReportBundle): BugReportFile[] {
	const files: BugReportFile[] = [
		{ name: "report.json", contentType: "application/json", data: `${JSON.stringify(bundle.metadata, null, 2)}\n` },
		{
			name: "diagnostics.json",
			contentType: "application/json",
			data: `${JSON.stringify(bundle.diagnostics, null, 2)}\n`,
		},
	];
	if (bundle.sessionJsonl !== undefined) {
		files.push({ name: "session.jsonl", contentType: "application/x-ndjson", data: bundle.sessionJsonl });
	}
	if (bundle.summary !== undefined) {
		files.push({
			name: "summary.md",
			contentType: "text/markdown",
			data: bundle.summary.endsWith("\n") ? bundle.summary : `${bundle.summary}\n`,
		});
	}
	return files;
}

export function writeBugReportArchive(bundle: BugReportBundle, filePath: string): Promise<void> {
	return writeZipArchive(filePath, bugReportFiles(bundle));
}

export function bugReportArchiveFileName(id: string): string {
	return `pi-bug-report-${id}.zip`;
}

const BUG_SUMMARY_SYSTEM_PROMPT = `You are helping a user file a bug report about pi, the coding agent they are talking to. You will be shown the conversation transcript. Write a report for the pi developers describing what the user was doing and what went wrong.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the report.`;

const BUG_SUMMARY_INSTRUCTIONS = `Write the bug report in Markdown with these sections:

## What the user was doing
One short paragraph.

## What went wrong
Concrete description of the failure: wrong output, errors, hangs, tool failures, unexpected behavior. Quote error messages and tool output verbatim where they exist.

## Steps to reproduce
Numbered list, as specific as the transcript allows.

## Relevant details
Tool calls involved, files touched, model behavior, anything else that helps a developer reproduce or locate the problem.

Do not include file contents, secrets, or credentials from the transcript; refer to files by path only. Keep the report factual and concise.`;

function selectMessages(messages: readonly AgentMessage[], tokenBudget: number): AgentMessage[] {
	const selected: AgentMessage[] = [];
	let tokens = 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		const next = estimateTokens(message);
		if (selected.length > 0 && tokens + next > tokenBudget) break;
		selected.push(message);
		tokens += next;
	}
	return selected.reverse();
}

interface GenerateBugReportSummaryOptions {
	messages: readonly AgentMessage[];
	hint?: string;
	model: Model<Api>;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	signal: AbortSignal;
	thinkingLevel?: ThinkingLevel;
	streamFn?: StreamFn;
	retry?: RetryPolicy;
	sessionId?: string;
}

/** Ask the session model for a report when the user does not share the transcript. */
export async function generateBugReportSummary(options: GenerateBugReportSummaryOptions): Promise<string> {
	const { model } = options;
	const contextWindow = model.contextWindow > 0 ? model.contextWindow : 128_000;
	const messages = selectMessages(options.messages, Math.floor(contextWindow * 0.6));
	const hint = options.hint?.trim();
	const prompt = [
		messages.length < options.messages.length
			? `Note: only the last ${messages.length} of ${options.messages.length} messages are shown.`
			: undefined,
		`<conversation>\n${serializeConversation(convertToLlm(messages))}\n</conversation>`,
		hint ? `<user-report>\n${hint}\n</user-report>` : undefined,
		BUG_SUMMARY_INSTRUCTIONS,
	]
		.filter((part) => part !== undefined)
		.join("\n\n");
	const requestOptions: SimpleStreamOptions = {
		maxTokens: Math.min(4096, model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY),
		signal: options.signal,
		apiKey: options.apiKey,
		headers: options.headers,
		env: options.env,
		sessionId: options.sessionId,
		...(model.reasoning && options.thinkingLevel && options.thinkingLevel !== "off"
			? { reasoning: options.thinkingLevel }
			: {}),
	};
	const response = await completeSummarization(
		model,
		normalizeContext({
			systemPrompt: BUG_SUMMARY_SYSTEM_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
		}),
		requestOptions,
		options.streamFn,
		options.retry,
	);
	if (response.stopReason === "aborted") throw new Error("Bug report summary was cancelled");
	const failure = getSummarizationFailure(response, "Bug report summary");
	if (failure) throw new Error(failure);
	if (response.content.some((block) => block.type === "toolCall")) {
		throw new Error("Bug report summary attempted to call a tool");
	}
	const text = contentText(response.content).trim();
	if (!text) throw new Error("Bug report summary was empty");
	return text;
}
