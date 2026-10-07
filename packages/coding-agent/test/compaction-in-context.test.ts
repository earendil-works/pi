import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	appendInContextCompactionRequest,
	evaluateInContextCompaction,
	IN_CONTEXT_COMPACTION_INSTRUCTIONS,
	IN_CONTEXT_COMPACTION_PROMPT,
	type InContextCompactionInput,
	prepareCompaction,
} from "../src/core/compaction/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function createModel(overrides: Partial<Model<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return {
		id: "cached-model",
		name: "Cached Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		promptCache: { short: 300, long: 3600 },
		contextWindow: 200000,
		maxTokens: 64000,
		compat: { supportsMidConvoSystemMessages: true, supportsInContextCompaction: true },
		...overrides,
	};
}

function usage(input: number, cacheRead: number, cacheWrite: number): Usage {
	return {
		input,
		output: 100,
		cacheRead,
		cacheWrite,
		totalTokens: input + cacheRead + cacheWrite + 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

interface SessionOptions {
	historyChars?: number;
	lastUsage?: Usage;
	ageMs?: number;
	responseProvider?: string;
	cacheWarmed?: boolean;
}

/** Three turns of history; the last response reports usage that `evaluateInContextCompaction` trusts. */
function createInput(
	model = createModel(),
	options: SessionOptions = {},
	thinkingLevel: InContextCompactionInput["thinkingLevel"] = "high",
): InContextCompactionInput {
	const now = Date.now();
	const sessionManager = SessionManager.inMemory();
	const historyChars = options.historyChars ?? 40000;
	for (let turn = 0; turn < 3; turn++) {
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `Question ${turn}. ${"x".repeat(historyChars)}` }],
			timestamp: now - 60_000,
		});
		const response: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: `Answer ${turn}.` }],
			api: model.api,
			provider: turn === 2 ? (options.responseProvider ?? model.provider) : model.provider,
			model: model.id,
			thinkingLevel: "high",
			usage: turn === 2 ? (options.lastUsage ?? usage(100, 40000, 500)) : usage(100, 0, 0),
			stopReason: "stop",
			timestamp: now - (turn === 2 ? (options.ageMs ?? 30_000) : 60_000),
		};
		sessionManager.appendMessage(response);
	}
	if (options.cacheWarmed) sessionManager.appendUsage("cache_warm", model.provider, model.id, usage(0, 40000, 0));
	const branchEntries = sessionManager.getBranch();
	const preparation = prepareCompaction(branchEntries, { enabled: true, reserveTokens: 16384, keepRecentTokens: 100 });
	if (!preparation) throw new Error("expected a compactable session");
	return {
		model,
		projection: sessionManager.buildSessionProjection(),
		branchEntries,
		preparation,
		thinkingLevel,
		now,
	};
}

describe("evaluateInContextCompaction", () => {
	it("uses in-context compaction while the cache is warm and cheaper", () => {
		const decision = evaluateInContextCompaction(createInput());
		expect(decision.use).toBe(true);
		if (!decision.use) return;
		expect(decision.priced).toBe(true);
		expect(decision.cachedTokens).toBe(40600);
		expect(decision.inContextCost).toBeLessThan(decision.standaloneCost);
	});

	it.each<[string, () => InContextCompactionInput, string]>([
		[
			"models without the catalog flag",
			() => createInput(createModel({ compat: { supportsMidConvoSystemMessages: true } })),
			"not verified",
		],
		[
			"responses from another model",
			() => createInput(createModel(), { responseProvider: "other" }),
			"different model",
		],
		["changed thinking levels", () => createInput(createModel(), {}, "low"), "thinking level changed"],
		[
			"responses without cache activity",
			() => createInput(createModel(), { lastUsage: usage(40600, 0, 0) }),
			"no prompt caching",
		],
		["expired caches", () => createInput(createModel(), { ageMs: 10 * 60_000 }), "expired"],
		["full contexts", () => createInput(createModel({ contextWindow: 50000 })), "too full"],
		[
			"small histories where the standalone prompt is cheaper",
			() => createInput(createModel(), { historyChars: 1000 }),
			"standalone summary is cheaper",
		],
	])("falls back for %s", (_label, input, reason) => {
		const decision = evaluateInContextCompaction(input());
		expect(decision.use).toBe(false);
		if (!decision.use) expect(decision.reason).toContain(reason);
	});

	it("counts cache warming as a cache refresh", () => {
		const decision = evaluateInContextCompaction(
			createInput(createModel(), { ageMs: 10 * 60_000, cacheWarmed: true }),
		);
		expect(decision.use).toBe(true);
	});

	it("weights cached tokens when the model has no prices", () => {
		const free = createModel({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
		const decision = evaluateInContextCompaction(createInput(free));
		expect(decision.use).toBe(true);
		if (decision.use) expect(decision.priced).toBe(false);
	});
});

describe("appendInContextCompactionRequest", () => {
	it("appends the instructions as a system message and the request as a user message", () => {
		const messages = appendInContextCompactionRequest(
			[{ role: "user", content: "hello", timestamp: 1 }],
			"focus on tests",
		);
		expect(messages.map((message) => message.role)).toEqual(["user", "system", "user"]);
		expect(messages[1].content).toBe(IN_CONTEXT_COMPACTION_INSTRUCTIONS);
		expect(messages[2].content).toEqual([
			{ type: "text", text: `${IN_CONTEXT_COMPACTION_PROMPT}\n\nAdditional focus: focus on tests` },
		]);
	});
});
