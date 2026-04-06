import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Context, Message, Model } from "@kennyfrc/mu-ai";
import { loadThreadMessagesFromSessionFile } from "./tools/read-thread-session.js";

export type ReplayProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages";

export type PromptCacheReplayProjection = {
	api: ReplayProviderApi;
	turnIndex: number;
	stablePrefixHash: string;
	toolLayerHash: string | null;
	longestCommonPrefixBytes: number;
	payload: unknown;
};

export type PromptCacheReplayReport = {
	sessionPath: string;
	messageCount: number;
	projections: PromptCacheReplayProjection[];
	warnings: string[];
	turns: Record<ReplayProviderApi, PromptCacheReplayProjection[]>;
};

type PromptCacheLayer = {
	id: "system" | "tools" | "context" | "history";
	stability: "stable" | "volatile";
	content: string;
	fingerprint: string;
};

type PromptCachePlan = {
	context: Context;
	layers: PromptCacheLayer[];
	stablePrefixFingerprint: string;
};

type PromptCachePolicyModule = {
	planPromptCachePolicy(args: { model: Model<ReplayProviderApi>; context: Context }): PromptCachePlan;
};

type OpenAICompletionsProviderModule = {
	projectOpenAICompletionsRequest(model: Model<"openai-completions">, context: Context): unknown;
};

type OpenAIResponsesProviderModule = {
	projectOpenAIResponsesRequest(model: Model<"openai-responses">, context: Context): unknown;
};

type AnthropicProviderModule = {
	projectAnthropicRequest(model: Model<"anthropic-messages">, context: Context): unknown;
};

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function longestCommonPrefixBytes(left: string, right: string): number {
	const max = Math.min(left.length, right.length);
	let index = 0;
	while (index < max && left.charCodeAt(index) === right.charCodeAt(index)) {
		index += 1;
	}
	return Buffer.byteLength(left.slice(0, index), "utf8");
}

function collectReplayWindows(messages: Message[]): Message[][] {
	const windows: Message[][] = [];
	for (let index = 0; index < messages.length; index += 1) {
		const current = messages[index];
		if (!current) continue;
		if (current.role === "user" || current.role === "toolResult") {
			windows.push(messages.slice(0, index + 1));
		}
	}
	if (windows.length === 0 && messages.length > 0) {
		windows.push([...messages]);
	}
	return windows;
}

function createReplayModel<TApi extends ReplayProviderApi>(api: TApi): Model<TApi> {
	if (api === "openai-completions") {
		return {
			id: "gpt-4o",
			name: "GPT-4o",
			api,
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		} as Model<TApi>;
	}
	if (api === "openai-responses") {
		return {
			id: "gpt-5-mini",
			name: "GPT-5 Mini",
			api,
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		} as Model<TApi>;
	}
	return {
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api,
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	} as Model<TApi>;
}

async function loadPromptCachePolicyModule(): Promise<PromptCachePolicyModule> {
	return (await import(
		new URL("../../ai/src/prompt-cache-policy.js", import.meta.url).href
	)) as PromptCachePolicyModule;
}

async function projectProviderPayload(api: ReplayProviderApi, context: Context): Promise<unknown> {
	if (api === "openai-completions") {
		const mod = (await import(
			new URL("../../ai/src/providers/openai-completions.ts", import.meta.url).href
		)) as OpenAICompletionsProviderModule;
		return mod.projectOpenAICompletionsRequest(createReplayModel(api), context);
	}
	if (api === "openai-responses") {
		const mod = (await import(
			new URL("../../ai/src/providers/openai-responses.ts", import.meta.url).href
		)) as OpenAIResponsesProviderModule;
		return mod.projectOpenAIResponsesRequest(createReplayModel(api), context);
	}
	const mod = (await import(
		new URL("../../ai/src/providers/anthropic.ts", import.meta.url).href
	)) as AnthropicProviderModule;
	return mod.projectAnthropicRequest(createReplayModel(api), context);
}

export function resolveDefaultReplaySessionRoots(): string[] {
	return [join(homedir(), ".mu", "sessions"), join(homedir(), ".mu", "agent", "sessions")];
}

export function findReplaySessionFiles(roots: string[] = resolveDefaultReplaySessionRoots()): string[] {
	const files: Array<{ path: string; mtimeMs: number }> = [];

	const visit = (root: string) => {
		if (!existsSync(root)) return;
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			const fullPath = join(root, entry.name);
			if (entry.isDirectory()) {
				visit(fullPath);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			files.push({ path: fullPath, mtimeMs: statSync(fullPath).mtimeMs });
		}
	};

	for (const root of roots) {
		visit(root);
	}

	return files.sort((left, right) => right.mtimeMs - left.mtimeMs).map((entry) => entry.path);
}

export async function buildPromptCacheReplayReport(args: {
	sessionPath: string;
	providers: ReplayProviderApi[];
	messages?: Message[];
}): Promise<PromptCacheReplayReport> {
	const messages = args.messages ?? loadThreadMessagesFromSessionFile(args.sessionPath).messages;
	const windows = collectReplayWindows(messages);
	const warnings: string[] = [];
	const turns: Record<ReplayProviderApi, PromptCacheReplayProjection[]> = {
		"openai-completions": [],
		"openai-responses": [],
		"anthropic-messages": [],
	};

	const promptCachePolicy = await loadPromptCachePolicyModule();

	for (const api of args.providers) {
		let previousPayload = "";
		for (let index = 0; index < windows.length; index += 1) {
			const window = windows[index] ?? [];
			const context: Context = { messages: window };
			const plan = promptCachePolicy.planPromptCachePolicy({
				model: createReplayModel(api),
				context,
			});
			const payload = await projectProviderPayload(api, plan.context);
			const serializedPayload = JSON.stringify(payload);
			const toolLayerHash = plan.layers.find((layer) => layer.id === "tools")?.fingerprint ?? null;
			const projection: PromptCacheReplayProjection = {
				api,
				turnIndex: index + 1,
				stablePrefixHash: plan.stablePrefixFingerprint || hashText(serializedPayload),
				toolLayerHash,
				longestCommonPrefixBytes:
					previousPayload.length === 0 ? 0 : longestCommonPrefixBytes(previousPayload, serializedPayload),
				payload,
			};
			turns[api].push(projection);
			previousPayload = serializedPayload;
		}
		if (turns[api].length === 0) {
			warnings.push(`No replay projections were produced for ${api}.`);
		}
	}

	const projections = args.providers
		.map((api) => turns[api][turns[api].length - 1])
		.filter((projection): projection is PromptCacheReplayProjection => projection !== undefined);

	return {
		sessionPath: args.sessionPath,
		messageCount: messages.length,
		projections,
		warnings,
		turns,
	};
}
