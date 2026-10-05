import { type AssistantMessage, type Model, type Models, normalizeContext, uuidv7 } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
	AssistantEntry,
	type ConversationId,
	createRegistry,
	type EntryId,
	Harness,
	MemoryStorage,
	ProviderDoc,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { streamSimple as streamSimpleOpenAICodexResponses } from "../../ai/src/api/openai-codex-responses.ts";
import { resolveApiKey } from "../../ai/test/oauth.ts";
import { context } from "./session-support.ts";

const codexToken = await resolveApiKey("openai-codex");

function cacheProbe(nonce: string): string {
	const lines = [
		"This is a real automated prompt-cache test. The repeated context below is intentional.",
		"Read it silently, then reply with exactly: CACHE PROBE READY",
	];
	for (let index = 0; index < 180; index++) {
		lines.push(
			`${nonce} immutable cache record ${String(index).padStart(3, "0")}: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega.`,
		);
	}
	return lines.join("\n");
}

function assistant(harness: Harness, conversationId: ConversationId, answer: EntryId) {
	return harness
		.commit((tx) => tx.entry(AssistantEntry, answer), context)
		.then((record) => {
			if (record?.conversationId !== conversationId) throw new Error("Answer belongs to another conversation");
			return record.model?.[0] as AssistantMessage | undefined;
		});
}

function cacheHitRate(usage: AssistantMessage["usage"]): number {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	return promptTokens === 0 ? 0 : usage.cacheRead / promptTokens;
}

describe("Durable provider session cache e2e", () => {
	// Live regression coverage for #10424; skipped without ~/.pi/agent/auth.json credentials.
	it.skipIf(!codexToken)(
		"reuses the Codex prompt cache across Durable turns",
		{ retry: 2, timeout: 120_000 },
		async () => {
			const base = builtinModels();
			const forwarded: string[] = [];
			const models = new Proxy(base, {
				get(target, property) {
					if (property === "streamSimple") {
						return (
							model: Parameters<Models["streamSimple"]>[0],
							request: Parameters<Models["streamSimple"]>[1],
							options?: Parameters<Models["streamSimple"]>[2],
						) => {
							forwarded.push(options?.sessionId ?? "");
							return streamSimpleOpenAICodexResponses(
								model as Model<"openai-codex-responses">,
								normalizeContext(request),
								{
									...options,
									apiKey: codexToken,
									transport: "sse",
								},
							);
						};
					}
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}) as Models;
			const harness = await Harness.open(
				new MemoryStorage(),
				{
					models,
					registry: createRegistry(),
					settings: {
						stream: { transport: "sse" },
						compaction: { enabled: false },
					},
				},
				context,
			);
			try {
				const root = await harness.root(context, {
					agent: { model: { provider: "openai-codex", modelId: "gpt-5.5" } },
				});
				harness.resume();
				const usages: AssistantMessage["usage"][] = [];
				let firstHit: number | undefined;
				for (let turn = 0; turn < 8; turn++) {
					const content = turn === 0 ? cacheProbe(uuidv7()) : `Reply exactly: CACHE PROBE FOLLOW-UP ${turn}`;
					const settled = await (await root.submit({ type: "input", content }, context)).wait(context);
					if (settled.status !== "done" || settled.type !== "input") {
						throw new Error(`Unexpected submission status: ${settled.status}`);
					}
					const message = await assistant(harness, root.id, settled.answer);
					expect(message?.stopReason, message?.errorMessage).not.toBe("error");
					usages.push(message!.usage);
					if (firstHit === undefined && message!.usage.cacheRead > 0) firstHit = usages.length - 1;
					if (firstHit !== undefined && usages.length - firstHit >= 3) break;
				}
				const sessionId = (await harness.snapshot(ProviderDoc, root.id, context))!.sessionId;
				expect(forwarded).toEqual(Array.from({ length: usages.length }, () => sessionId));
				const firstPrompt = usages[0]!.input + usages[0]!.cacheRead + usages[0]!.cacheWrite;
				expect(firstPrompt).toBeGreaterThanOrEqual(4_000);
				expect(usages[0]!.cacheRead).toBe(0);
				expect(firstHit).toBe(1);
				if (firstHit === undefined) throw new Error("Codex reported no prompt-cache hit");
				const cached = usages.slice(firstHit);
				expect(cached).toHaveLength(3);
				for (const usage of cached) expect(cacheHitRate(usage)).toBeGreaterThanOrEqual(0.9);
			} finally {
				await harness.close(context);
			}
		},
	);
});
