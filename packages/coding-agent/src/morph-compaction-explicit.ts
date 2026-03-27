import type { Api, AssistantMessage, Message, Model } from "@kennyfrc/mu-ai";

import { normalizeMorphCompactionQuery, projectMessagesToMorphTranscript } from "./morph-compaction-projector.js";
import { type MorphCompactionStrategy, selectCompactionStrategy } from "./morph-compaction-strategy.js";
import { estimateTokens, type HandoffDetails } from "./tools/handoff.js";

type MorphCompactResponse = {
	output?: unknown;
};

type NativeReplayExecution = {
	details: HandoffDetails;
	usedFallback: boolean;
	fallbackReason?: string;
};

export type ExplicitCompactionExecution = {
	strategy: MorphCompactionStrategy;
	details: HandoffDetails;
};

function buildMorphFormattedMessage(args: {
	goal: string;
	query: string;
	compressionRatio: number;
	keyFiles: string[];
}): string {
	return [
		"## Goal",
		args.goal.trim(),
		"",
		"## Constraints & Preferences",
		"- Preserve parent thread context and use `read_thread` when needed.",
		"- Reuse the Morph-compacted visible history above as the active context for the next turn.",
		"",
		"## Progress",
		"### Done",
		"- Morph compaction completed for the visible session history.",
		"- A structured Mu checkpoint was appended so continuation remains readable across models.",
		"",
		"### In Progress",
		"- [ ] Review the Morph-compacted history and continue from the next concrete action.",
		"",
		"### Blocked",
		"- (none)",
		"",
		"## Key Decisions",
		"- Morph was used only for visible-history compaction on a safe non-native-replay path.",
		`- Query used for compaction: ${args.query}`,
		`- Compression ratio used: ${args.compressionRatio}`,
		"",
		"## Next Steps",
		"1. Continue from the Morph-compacted history above.",
		"2. Inspect the relevant files and resume the task from the structured checkpoint below.",
		"",
		"## Critical Context",
		...(args.keyFiles.length > 0
			? args.keyFiles.map((file) => `- Key file: ${file}`)
			: ["- Key files were not provided in this compaction result."]),
	].join("\n");
}

async function compactVisibleHistoryWithMorph(args: {
	model: Model<Api>;
	messages: Message[];
	goal: string;
	apiKey: string;
	compressionRatio: number;
	keyFiles: string[];
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}): Promise<HandoffDetails> {
	const fetchImpl = args.fetchImpl ?? fetch;
	const input = projectMessagesToMorphTranscript(args.messages);
	const query = normalizeMorphCompactionQuery({ messages: args.messages, explicitGoal: args.goal });

	const response = await fetchImpl("https://api.morphllm.com/v1/compact", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${args.apiKey}`,
		},
		body: JSON.stringify({
			input,
			query,
			compression_ratio: args.compressionRatio,
			preserve_recent: 0,
		}),
		signal: args.signal,
	});

	let payload: MorphCompactResponse | null = null;
	try {
		payload = (await response.json()) as MorphCompactResponse;
	} catch {
		payload = null;
	}

	if (!response.ok) {
		throw new Error(`Morph compaction failed: ${response.status} ${response.statusText}`.trim());
	}

	if (!payload || typeof payload.output !== "string" || payload.output.trim().length === 0) {
		throw new Error("Morph compaction returned no usable output");
	}

	const replacementText = payload.output.trim();
	const replacementMessage: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: replacementText }],
		api: args.model.api,
		provider: args.model.provider,
		model: args.model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	const formattedMessage = buildMorphFormattedMessage({
		goal: args.goal,
		query,
		compressionRatio: args.compressionRatio,
		keyFiles: args.keyFiles,
	});

	return {
		handoffType: "explicit",
		goal: args.goal.trim(),
		formattedMessage,
		parentSessionId: "",
		fileTokens: estimateTokens(replacementText) + estimateTokens(formattedMessage),
		replacementMessages: [replacementMessage],
		keyFiles: args.keyFiles,
	};
}

export async function executeExplicitCompactionStrategy(args: {
	model: Model<Api>;
	messages: Message[];
	goal: string;
	morphApiKey?: string | null;
	keyFiles: string[];
	signal?: AbortSignal;
	localSummaryFallback: () => Promise<HandoffDetails>;
	nativeReplayCompact: () => Promise<NativeReplayExecution>;
	fetchImpl?: typeof fetch;
}): Promise<ExplicitCompactionExecution> {
	const transcript = projectMessagesToMorphTranscript(args.messages);
	const estimatedHistoryTokens = estimateTokens(transcript);
	const morphApiKey = args.morphApiKey?.trim() || "";
	void args.localSummaryFallback;
	void args.nativeReplayCompact;

	const strategy = selectCompactionStrategy({
		model: args.model,
		hasMorphApiKey: morphApiKey.length > 0,
		estimatedHistoryTokens,
		contextWindow: args.model.contextWindow,
	});

	if (strategy.kind === "cannot-compact") {
		throw new Error(strategy.reason);
	}

	return {
		strategy,
		details: await compactVisibleHistoryWithMorph({
			model: args.model,
			messages: args.messages,
			goal: args.goal,
			apiKey: morphApiKey,
			compressionRatio: strategy.compressionRatio,
			keyFiles: args.keyFiles,
			signal: args.signal,
			fetchImpl: args.fetchImpl,
		}),
	};
}
