import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionBeforeCompactEvent } from "../../src/core/extensions/index.ts";
import { createHarness, type Harness } from "./harness.ts";

function seedHistory(harness: Harness, totalTokens = 650): string {
	const model = harness.session.model!;
	let recentUserId = "";
	for (const label of ["old", "recent"]) {
		recentUserId = harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: label.padEnd(400, "x") }],
			timestamp: Date.now() - 2000,
		});
		const assistant = fauxAssistantMessage(label.padEnd(400, "y"), { timestamp: Date.now() - 1000 });
		harness.sessionManager.appendMessage({
			...assistant,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { ...assistant.usage, input: totalTokens, totalTokens },
		});
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return recentUserId;
}

// Regression coverage for #8133.
describe("AgentSession compaction model overrides", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it.each(["manual", "pre-prompt", "post-run", "overflow"] as const)(
		"uses model token settings for %s compaction and extension preparation",
		async (path) => {
			const preparations: SessionBeforeCompactEvent[] = [];
			const harness = await createHarness({
				models: [{ id: "faux-1", contextWindow: 4000 }],
				tools: [],
				settings: {
					compaction: {
						enabled: path !== "manual",
						reserveTokens: 10,
						keepRecentTokens: 20000,
						modelOverrides: { "faux/faux-1": { reserveTokens: 2000, keepRecentTokens: 150 } },
					},
				},
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", (event) => {
							preparations.push(event);
							return {
								compaction: {
									summary: "compacted history",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
								},
							};
						});
					},
				],
			});
			harnesses.push(harness);
			const recentUserId = seedHistory(harness, path === "pre-prompt" ? 2500 : 650);

			if (path === "manual") {
				await harness.session.compact();
			} else {
				harness.setResponses(
					path === "overflow"
						? [
								fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
								fauxAssistantMessage("recovered"),
							]
						: [fauxAssistantMessage(path === "post-run" ? "z".repeat(8000) : "done")],
				);
				await harness.session.prompt("continue");
			}

			expect(preparations).toHaveLength(1);
			expect(preparations[0]?.preparation.settings).toEqual({
				enabled: path !== "manual",
				reserveTokens: 2000,
				keepRecentTokens: 150,
			});
			expect(preparations[0]?.reason).toBe(
				path === "manual" ? "manual" : path === "overflow" ? "overflow" : "threshold",
			);
			if (path === "manual" || path === "pre-prompt") {
				expect(preparations[0]?.preparation.firstKeptEntryId).toBe(recentUserId);
			}
			expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
			expect(harness.eventsOfType("compaction_end")[0]).toMatchObject({
				aborted: false,
				willRetry: path === "overflow",
				result: { summary: "compacted history" },
			});
			expect(harness.getPendingResponseCount()).toBe(0);
		},
	);

	it.each(["manual", "automatic"] as const)("passes resolved budgets to built-in %s summarization", async (path) => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 4000, maxTokens: 3000 }],
			tools: [],
			settings: {
				compaction: {
					reserveTokens: 10,
					modelOverrides: { "faux/faux-1": { reserveTokens: 2000, keepRecentTokens: 150 } },
				},
			},
		});
		harnesses.push(harness);
		const recentUserId = seedHistory(harness, 2500);
		const budgets: Array<number | undefined> = [];
		harness.setResponses([
			(_context, options) => {
				budgets.push(options?.maxTokens);
				return fauxAssistantMessage("built-in summary");
			},
			...(path === "automatic" ? [fauxAssistantMessage("done")] : []),
		]);
		if (path === "manual") await harness.session.compact();
		else await harness.session.prompt("continue");
		expect(budgets).toEqual([1600]);
		expect(harness.sessionManager.getEntries().find((entry) => entry.type === "compaction")).toMatchObject({
			firstKeptEntryId: recentUserId,
			summary: "built-in summary",
		});
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("uses the newly selected model without changing ordinary settings", async () => {
		const harness = await createHarness({
			models: [
				{ id: "small", contextWindow: 4000 },
				{ id: "big", contextWindow: 10000 },
			],
			tools: [],
			settings: {
				compaction: {
					reserveTokens: 10,
					modelOverrides: { "faux/big": { reserveTokens: 8000, keepRecentTokens: 150 } },
				},
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "big model summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedHistory(harness, 2500);
		harness.setResponses([fauxAssistantMessage("small response"), fauxAssistantMessage("big response")]);
		await harness.session.prompt("continue on small");
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		// Retain usage from the small model: the next check must use the active big model's policy.
		seedHistory(harness, 2500);
		await harness.session.setModel(harness.getModel("big")!);
		await harness.session.prompt("continue on big");
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")[0]?.result?.summary).toBe("big model summary");
		expect(harness.settingsManager.getCompactionReserveTokens()).toBe(10);
		await harness.session.setModel(harness.getModel("small")!);
		expect(harness.settingsManager.getCompactionReserveTokens(harness.session.model)).toBe(10);
	});

	it("captures model identity before awaiting summarization auth", async () => {
		const harness = await createHarness({
			models: [{ id: "first" }, { id: "second" }],
			settings: {
				compaction: {
					modelOverrides: {
						"faux/first": { reserveTokens: 2000, keepRecentTokens: 150 },
						"faux/second": { reserveTokens: 4000, keepRecentTokens: 20000 },
					},
				},
			},
		});
		harnesses.push(harness);
		seedHistory(harness);
		const getAuth = harness.session.modelRuntime.getAuth.bind(harness.session.modelRuntime);
		vi.spyOn(harness.session.modelRuntime, "getAuth").mockImplementation(async (model, ...args) => {
			harness.session.agent.state.model = harness.getModel("second")!;
			return getAuth(model, ...args);
		});
		const requests: Array<{ id: string; maxTokens: number | undefined }> = [];
		harness.setResponses([
			(_context, options, _state, model) => {
				requests.push({ id: model.id, maxTokens: options?.maxTokens });
				return fauxAssistantMessage("summary");
			},
		]);
		await harness.session.compact();
		expect(requests).toEqual([{ id: "first", maxTokens: 1600 }]);
	});
});
