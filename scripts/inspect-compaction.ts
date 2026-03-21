import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	MU_STATIC_INSTRUCTIONS,
	type Api,
	type AssistantMessage,
	type Context,
	type Message,
	type Model,
} from "@kennyfrc/mu-ai";
import {
	buildCompactionContinuationPrompt,
	buildCompactionCheckpointText,
} from "../packages/coding-agent/src/compaction-checkpoint.js";
import { extractHandoffFileTracking } from "../packages/coding-agent/src/handoff-file-tracking.js";
import { findModel } from "../packages/coding-agent/src/model-config.js";
import { executeExplicitCompactionStrategy } from "../packages/coding-agent/src/morph-compaction-explicit.js";
import { buildSystemPrompt } from "../packages/coding-agent/src/prompts/index.js";
import { resolveToolSelection } from "../packages/coding-agent/src/tools/tool-selection.js";

type JsonRecord = Record<string, unknown>;

type SessionHeader = {
	type: "session";
	id: string;
	cwd?: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
	timestamp?: string;
	branchedFrom?: string;
};

type ModelChangeEntry = {
	type: "model_change";
	provider: string;
	modelId: string;
};

type SessionMessageEntry = {
	type: "message";
	message: Message;
};

type ContextCompactionEntry = {
	type: "context_compaction";
	replacementMessages: Message[];
};

type SessionParseResult = {
	sessionFile: string;
	header: SessionHeader;
	activeMessages: Message[];
	counts: Record<string, number>;
	lineCount: number;
	lastProvider: string;
	lastModelId: string;
	hasContextCompaction: boolean;
};

type ContextFile = { path: string; content: string; scope: "user" | "project" };

type StubMorphRequest = {
	input?: string;
	query?: string;
	compression_ratio?: number;
	preserve_recent?: number;
};

type Artifact = {
	generatedAt: string;
	sessionRootsSearched: string[];
	selectedSession: {
		file: string;
		legacyPathNote: string;
		cwd: string;
		sessionId: string;
		provider: string;
		modelId: string;
		lineCount: number;
		counts: Record<string, number>;
		hasContextCompaction: boolean;
	};
	model: {
		provider: string;
		id: string;
		api: Api;
		contextWindow: number;
		maxTokens: number;
	};
	compaction: {
		goal: string;
		strategy: string;
		keyFiles: string[];
		stubMorphRequest: StubMorphRequest;
		stubMorphOutput: string;
		replacementMessagesFromCompactor: Message[];
		replacementMessagesAfterCheckpointInjection: Message[];
		contextCompactionEntry: ContextCompactionEntry;
		continuationPrompt: string;
		finalMessagesBeforeNextModelCall: Message[];
	};
	systemPrompt: {
		contextFiles: Array<{ path: string; scope: "user" | "project" }>;
		toolNames: string[];
		fullPrompt: string;
	};
	requestPreview: {
		providerBehavior: string;
		instructions: string;
		developerMessages: Array<{
			type: "message";
			role: "developer";
			content: Array<{ type: "input_text"; text: string }>;
		}>;
		input: unknown[];
		tools: Array<{ name: string; description: string }>;
	};
};

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMessage(value: unknown): value is Message {
	if (!isRecord(value)) return false;
	return value.role === "user" || value.role === "assistant" || value.role === "toolResult";
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function parseJsonLine(line: string): JsonRecord | null {
	try {
		const parsed: unknown = JSON.parse(line);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function collectSessionFiles(root: string): string[] {
	const out: string[] = [];

	function walk(dir: string): void {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				out.push(full);
			}
		}
	}

	walk(root);
	return out;
}

function parseSessionFile(sessionFile: string): SessionParseResult | null {
	const lines = readFileSync(sessionFile, "utf8").split(/\r?\n/).filter((line) => line.length > 0);
	if (lines.length === 0) return null;

	let header: SessionHeader | null = null;
	let lastProvider = "";
	let lastModelId = "";
	let hasContextCompaction = false;
	const counts: Record<string, number> = {};
	const activeMessages: Message[] = [];

	for (const line of lines) {
		const entry = parseJsonLine(line);
		if (!entry) continue;
		const type = asString(entry.type);
		if (!type) continue;
		counts[type] = (counts[type] ?? 0) + 1;

		if (type === "session") {
			header = {
				type: "session",
				id: asString(entry.id) ?? "",
				cwd: asString(entry.cwd),
				provider: asString(entry.provider),
				modelId: asString(entry.modelId),
				thinkingLevel: asString(entry.thinkingLevel),
				timestamp: asString(entry.timestamp),
				branchedFrom: asString(entry.branchedFrom),
			};
			lastProvider = header.provider ?? lastProvider;
			lastModelId = header.modelId ?? lastModelId;
			continue;
		}

		if (type === "model_change") {
			const modelChange: ModelChangeEntry = {
				type: "model_change",
				provider: asString(entry.provider) ?? lastProvider,
				modelId: asString(entry.modelId) ?? lastModelId,
			};
			lastProvider = modelChange.provider;
			lastModelId = modelChange.modelId;
			continue;
		}

		if (type === "context_compaction") {
			hasContextCompaction = true;
			const replacementRaw = entry.replacementMessages;
			if (Array.isArray(replacementRaw)) {
				activeMessages.length = 0;
				for (const message of replacementRaw) {
					if (isMessage(message)) activeMessages.push(message);
				}
			}
			continue;
		}

		if (type === "message") {
			const rawMessage = entry.message;
			if (isMessage(rawMessage)) activeMessages.push(rawMessage);
		}
	}

	if (!header || !header.id || !header.cwd) return null;

	return {
		sessionFile,
		header,
		activeMessages,
		counts,
		lineCount: lines.length,
		lastProvider,
		lastModelId,
		hasContextCompaction,
	};
}

function chooseSession(sessionRoots: string[]): SessionParseResult {
	const parsed: SessionParseResult[] = [];
	for (const root of sessionRoots) {
		for (const sessionFile of collectSessionFiles(root)) {
			const session = parseSessionFile(sessionFile);
			if (session) parsed.push(session);
		}
	}

	if (parsed.length === 0) {
		throw new Error(`No session files found under: ${sessionRoots.join(", ")}`);
	}

	parsed.sort((a, b) => b.lineCount - a.lineCount);
	const withoutExistingCompaction = parsed.find((session) => !session.hasContextCompaction);
	return withoutExistingCompaction ?? parsed[0];
}

function inferApi(provider: string, modelId: string, messages: Message[]): Api {
	if (provider === "openai-codex") return "openai-codex-responses";
	if (provider === "openai") return "openai-responses";
	if (provider === "anthropic") return "anthropic-messages";
	if (provider === "google") return "google-generative-ai";
	if (provider === "zai") return "zai-completions";
	for (const message of messages) {
		if (message.role === "assistant") return message.api;
	}
	if (modelId.toLowerCase().includes("gpt")) return "openai-responses";
	return "anthropic-messages";
}

function fallbackModel(provider: string, modelId: string, messages: Message[]): Model<Api> {
	const api = inferApi(provider, modelId, messages);
	return {
		provider,
		id: modelId,
		name: modelId,
		api,
		baseUrl: provider === "openai-codex" ? "https://chatgpt.com/backend-api/codex" : "",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	};
}

function loadContextFileFromDir(dir: string): { path: string; content: string } | null {
	const candidates = ["AGENTS.md", "CLAUDE.md"];
	for (const name of candidates) {
		const filePath = join(dir, name);
		try {
			const content = readFileSync(filePath, "utf8");
			return { path: filePath, content };
		} catch {
			// keep looking
		}
	}
	return null;
}

function loadContextFilesForCwd(targetCwd: string): ContextFile[] {
	const contextFiles: ContextFile[] = [];
	const homeAgentDir = resolve(process.env.MU_CODING_AGENT_DIR || join(homedir(), ".mu/agent"));
	const globalContext = loadContextFileFromDir(homeAgentDir);
	if (globalContext) {
		contextFiles.push({ ...globalContext, scope: "user" });
	}

	const ancestorContextFiles: ContextFile[] = [];
	let currentDir = resolve(targetCwd);
	const root = resolve("/");

	while (true) {
		const contextFile = loadContextFileFromDir(currentDir);
		if (contextFile) {
			ancestorContextFiles.unshift({ ...contextFile, scope: "project" });
		}
		if (currentDir === root) break;
		const parent = resolve(currentDir, "..");
		if (parent === currentDir) break;
		currentDir = parent;
	}

	contextFiles.push(...ancestorContextFiles);
	return contextFiles;
}

function messageText(message: Message): string {
	if (message.role === "user") {
		if (typeof message.content === "string") return message.content;
		return message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
	}
	if (message.role === "assistant") {
		return message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
	}
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function findLastMessageByRole(messages: Message[], role: Message["role"]): Message | null {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === role) return message;
	}
	return null;
}

function shorten(text: string, limit: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= limit) return trimmed;
	return `${trimmed.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function shortenJson(value: unknown, limit: number): string {
	return shorten(JSON.stringify(value, null, 2), limit);
}

function buildStubMorphOutput(args: { messages: Message[]; goal: string; session: SessionParseResult }): string {
	void args;
	return "[Morph output for compaction inspection]";
}

function buildContextCompactionMessages(args: {
	details: {
		formattedMessage: string;
		goal: string;
		keyFiles?: string[];
		replacementMessages?: Message[];
		compactionApplicationMode?: string;
	};
	parentSessionId: string | null;
}): Message[] {
	const replacementMessages = args.details.replacementMessages ?? [];
	if (replacementMessages.length > 0) {
		if (args.details.compactionApplicationMode === "goal-plus-replacement-history") {
			return replacementMessages;
		}

		return [
			...replacementMessages,
			{
				role: "user",
				content: [
					{
						type: "text",
						text: buildCompactionCheckpointText({
							formattedMessage: args.details.formattedMessage,
							goal: args.details.goal,
							parentThreadId: args.parentSessionId,
							keyFiles: args.details.keyFiles,
						}),
					},
				],
				timestamp: Date.now() + replacementMessages.length,
			},
		];
	}

	return [
		{
			role: "user",
			content: [
				{
					type: "text",
					text: buildCompactionCheckpointText({
						formattedMessage: args.details.formattedMessage,
						goal: args.details.goal,
						parentThreadId: args.parentSessionId,
						keyFiles: args.details.keyFiles,
					}),
				},
			],
			timestamp: Date.now(),
		},
	];
}

function buildCodexRequestPreview(args: {
	model: Model<Api>;
	systemPrompt: string;
	messages: Message[];
	toolNames: string[];
	tools: Array<{ name: string; description: string }>;
}): Artifact["requestPreview"] {
	const instructions = `<system_instructions>\n${MU_STATIC_INSTRUCTIONS.trim()}\n</system_instructions>`;
	const developerMessages = args.systemPrompt.trim()
		? [
				{
					type: "message" as const,
					role: "developer" as const,
					content: [{ type: "input_text" as const, text: args.systemPrompt }],
				},
			]
		: [];

	const input: unknown[] = [];
	for (const message of args.messages) {
		if (message.role === "user") {
			const text = messageText(message);
			input.push({
				role: "user",
				content: [{ type: "input_text", text }],
			});
			continue;
		}
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "text") continue;
				input.push({
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: block.text, annotations: [] }],
					status: "completed",
				});
			}
		}
	}

	return {
		providerBehavior: [
			"Preview is modeled on packages/ai/src/providers/openai-codex-responses.ts.",
			"The compacted replacement history is kept in session state, then a fresh continuation user prompt is appended immediately after compaction.",
			"On the next provider call, Mu prepends Codex static instructions plus the coding-agent system prompt as a developer message.",
		].join(" "),
		instructions,
		developerMessages,
		input,
		tools: args.tools,
	};
}

function formatMessageForMarkdown(message: Message): string {
	return [
		`- role: ${message.role}`,
		"```json",
		JSON.stringify(message, null, 2),
		"```",
	].join("\n");
}

function buildMarkdown(args: {
	artifact: Artifact;
	outputJsonPath: string;
	systemPromptPath: string;
	continuationPromptPath: string;
	requestPreviewPath: string;
}): string {
	const { artifact, outputJsonPath, continuationPromptPath, requestPreviewPath, systemPromptPath } = args;
	const replacementMessages = artifact.compaction.replacementMessagesAfterCheckpointInjection
		.map((message) => formatMessageForMarkdown(message))
		.join("\n\n");
	const finalMessages = artifact.compaction.finalMessagesBeforeNextModelCall
		.map((message) => formatMessageForMarkdown(message))
		.join("\n\n");
	const stubRequestPreview = {
		query: artifact.compaction.stubMorphRequest.query,
		compression_ratio: artifact.compaction.stubMorphRequest.compression_ratio,
		preserve_recent: artifact.compaction.stubMorphRequest.preserve_recent,
		inputPreview: shorten(artifact.compaction.stubMorphRequest.input ?? "", 3000),
	};
	const developerMessagePreview = artifact.requestPreview.developerMessages.map((message) => ({
		...message,
		content: message.content.map((part) => ({ ...part, text: shorten(part.text, 1200) })),
	}));
	const requestPreviewSummary = {
		instructions: shorten(artifact.requestPreview.instructions, 1600),
		developerMessages: developerMessagePreview,
		input: artifact.requestPreview.input,
		tools: artifact.requestPreview.tools,
	};

	return [
		"# Compaction Inspection Artifact",
		"",
		"This artifact shows the real Mu compaction flow around a saved long session, including what gets inserted before and after the compacted history.",
		"",
		"## Session chosen",
		`- Session file: \
\`${artifact.selectedSession.file}\``,
		`- Legacy note: ${artifact.selectedSession.legacyPathNote}`,
		`- Session cwd: \`${artifact.selectedSession.cwd}\``,
		`- Provider/model: \`${artifact.selectedSession.provider}/${artifact.selectedSession.modelId}\``,
		`- JSONL lines: ${artifact.selectedSession.lineCount}`,
		`- Existing context_compaction entries: ${artifact.selectedSession.counts.context_compaction ?? 0}`,
		"",
		"## What the script did",
		"1. Loaded the active message history from the session file using Mu session semantics (`context_compaction` would replace prior history; this selected session had none).",
		"2. Ran the real explicit compaction path via `executeExplicitCompactionStrategy(...)` with a stubbed Morph HTTP response so the internal Mu compaction plumbing still runs.",
		"3. Applied the same checkpoint injection logic Mu uses in `tui-renderer.ts`.",
		"4. Built the same continuation prompt Mu sends immediately after applying the compaction.",
		"5. Rendered a Codex-style next-request preview showing the prepended system/developer wrapper plus the compacted history and continuation prompt.",
		"",
		"## Stub Morph request",
		"```json",
		JSON.stringify(stubRequestPreview, null, 2),
		"```",
		`Full structured request: \`${outputJsonPath}\``,
		"",
		"## Stub Morph output",
		"```text",
		artifact.compaction.stubMorphOutput,
		"```",
		"",
		"## Replacement messages after Mu checkpoint injection",
		replacementMessages,
		"",
		"## Immediate continuation prompt Mu appends after compaction",
		"```text",
		artifact.compaction.continuationPrompt,
		"```",
		`Standalone file: \`${continuationPromptPath}\``,
		"",
		"## Final messages before the next model call",
		finalMessages,
		"",
		"## Prepended request wrapper",
		"### `instructions`",
		"```text",
		artifact.requestPreview.instructions,
		"```",
		"",
		"### Developer message Mu prepends",
		"```json",
		JSON.stringify(developerMessagePreview, null, 2),
		"```",
		"",
		"## Next-request preview summary",
		"```json",
		JSON.stringify(requestPreviewSummary, null, 2),
		"```",
		`Full request preview: \`${requestPreviewPath}\``,
		"",
		"## Full system prompt captured for this preview",
		`See \`${systemPromptPath}\`.`,
		"",
		"## Structured artifact JSON",
		`See \`${outputJsonPath}\` for the same data in structured form.`,
	].join("\n");
}

async function main(): Promise<void> {
	const sessionRoots = [join(homedir(), ".mu", "sessions"), join(homedir(), ".mu", "agent", "sessions")].filter((root) => {
		try {
			return statSync(root).isDirectory();
		} catch {
			return false;
		}
	});

	const selectedSession = chooseSession(sessionRoots);
	const provider = selectedSession.lastProvider || selectedSession.header.provider || "openai-codex";
	const modelId = selectedSession.lastModelId || selectedSession.header.modelId || "gpt-5.3-codex";
	const resolved = findModel(provider, modelId);
	const model = resolved.model ?? fallbackModel(provider, modelId, selectedSession.activeMessages);
	const tracking = extractHandoffFileTracking(selectedSession.activeMessages);
	const keyFiles = tracking.modifiedFiles;
	const goal = "Inspect how compaction gets injected on the next turn";

	let stubMorphRequest: StubMorphRequest = {};
	let stubMorphOutput = "";

	const execution = await executeExplicitCompactionStrategy({
		model,
		messages: selectedSession.activeMessages,
		goal,
		morphMode: "on",
		morphApiKey: "stub-morph-api-key",
		keyFiles,
		localSummaryFallback: async () => {
			throw new Error("Unexpected fallback path while generating compaction artifact");
		},
		nativeReplayCompact: async () => {
			throw new Error("Native replay compaction should not be used for this artifact");
		},
		fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => {
			const request = (() => {
				if (!init?.body || typeof init.body !== "string") return {};
				try {
					const parsed: unknown = JSON.parse(init.body);
					return isRecord(parsed) ? parsed : {};
				} catch {
					return {};
				}
			})();

			stubMorphRequest = {
				input: asString(request.input),
				query: asString(request.query),
				compression_ratio:
					typeof request.compression_ratio === "number" ? request.compression_ratio : undefined,
				preserve_recent: typeof request.preserve_recent === "number" ? request.preserve_recent : undefined,
			};

			stubMorphOutput = buildStubMorphOutput({
				messages: selectedSession.activeMessages,
				goal,
				session: selectedSession,
			});

			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({ output: stubMorphOutput }),
			} as Response;
		},
	});

	const parentSessionId = selectedSession.header.id;
	const replacementMessagesAfterCheckpointInjection = buildContextCompactionMessages({
		details: {
			...execution.details,
			compactionApplicationMode: "goal-plus-replacement-history",
		},
		parentSessionId,
	});

	const continuationPrompt = buildCompactionContinuationPrompt({
		formattedMessage: execution.details.formattedMessage,
		goal: execution.details.goal,
		parentThreadId: parentSessionId,
		keyFiles: execution.details.keyFiles,
	});

	const continuationPromptMessage: Message = {
		role: "user",
		content: [{ type: "text", text: continuationPrompt }],
		timestamp: Date.now() + replacementMessagesAfterCheckpointInjection.length + 1,
	};

	const finalMessagesBeforeNextModelCall = [...replacementMessagesAfterCheckpointInjection, continuationPromptMessage];

	const originalCwd = process.cwd();
	const targetCwd = selectedSession.header.cwd ?? originalCwd;
	process.chdir(targetCwd);
	const contextFiles = loadContextFilesForCwd(targetCwd);
	const toolSelection = resolveToolSelection(undefined, model);
	const toolPromptEntries = toolSelection.tools.map((tool) => ({ name: tool.name, description: tool.description }));
	const systemPrompt = await buildSystemPrompt({
		tools: toolPromptEntries,
		contextFiles,
	});
	process.chdir(originalCwd);

	const context: Context = {
		systemPrompt,
		messages: finalMessagesBeforeNextModelCall,
		tools: toolSelection.tools,
	};
	void context;

	const artifact: Artifact = {
		generatedAt: new Date().toISOString(),
		sessionRootsSearched: sessionRoots,
		selectedSession: {
			file: selectedSession.sessionFile,
			legacyPathNote:
				sessionRoots.includes(join(homedir(), ".mu", "sessions"))
					? "Used the standard root search order ~/.mu/sessions then ~/.mu/agent/sessions."
					: "~/.mu/sessions does not exist in this environment; actual sessions live under ~/.mu/agent/sessions.",
			cwd: targetCwd,
			sessionId: parentSessionId,
			provider,
			modelId,
			lineCount: selectedSession.lineCount,
			counts: selectedSession.counts,
			hasContextCompaction: selectedSession.hasContextCompaction,
		},
		model: {
			provider: model.provider,
			id: model.id,
			api: model.api,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		},
		compaction: {
			goal,
			strategy: execution.strategy.kind,
			keyFiles,
			stubMorphRequest,
			stubMorphOutput,
			replacementMessagesFromCompactor: execution.details.replacementMessages ?? [],
			replacementMessagesAfterCheckpointInjection,
			contextCompactionEntry: {
				type: "context_compaction",
				replacementMessages: replacementMessagesAfterCheckpointInjection,
			},
			continuationPrompt,
			finalMessagesBeforeNextModelCall,
		},
		systemPrompt: {
			contextFiles: contextFiles.map((file) => ({ path: file.path, scope: file.scope })),
			toolNames: toolSelection.toolNames,
			fullPrompt: systemPrompt,
		},
		requestPreview: buildCodexRequestPreview({
			model,
			systemPrompt,
			messages: finalMessagesBeforeNextModelCall,
			toolNames: toolSelection.toolNames,
			tools: toolPromptEntries,
		}),
	};

	const outputDir = join(process.cwd(), "devdocs", "compaction-inspection");
	mkdirSync(outputDir, { recursive: true });
	const outputJsonPath = join(outputDir, "artifact.json");
	const outputMarkdownPath = join(outputDir, "README.md");
	const systemPromptPath = join(outputDir, "system-prompt.txt");
	const continuationPromptPath = join(outputDir, "continuation-prompt.txt");
	const requestPreviewPath = join(outputDir, "request-preview.json");

	writeFileSync(outputJsonPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
	writeFileSync(systemPromptPath, `${artifact.systemPrompt.fullPrompt}\n`, "utf8");
	writeFileSync(continuationPromptPath, `${artifact.compaction.continuationPrompt}\n`, "utf8");
	writeFileSync(requestPreviewPath, `${JSON.stringify(artifact.requestPreview, null, 2)}\n`, "utf8");
	writeFileSync(
		outputMarkdownPath,
		`${buildMarkdown({
			artifact,
			outputJsonPath,
			systemPromptPath,
			continuationPromptPath,
			requestPreviewPath,
		})}\n`,
		"utf8",
	);

	process.stdout.write(
		`${outputMarkdownPath}\n${outputJsonPath}\n${systemPromptPath}\n${continuationPromptPath}\n${requestPreviewPath}\n`,
	);
}

void main();
