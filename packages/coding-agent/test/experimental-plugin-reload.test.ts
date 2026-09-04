import { defineFacet, type FacetLoader } from "@earendil-works/chord";
import { type AgentLane, BACKGROUND_CONTEXT, type LaneSnapshot } from "@earendil-works/pi-agent-core";
import { describe, expect, test, vi } from "vitest";
import { SessionPlugins } from "../src/experimental/services/plugins.ts";
import { createSessionWorkerServices } from "../src/experimental/services/worker.ts";

describe("experimental plugin reload", () => {
	test("loads and cuts over a fresh Session facet generation", async () => {
		const activations: number[] = [];
		const disposals: number[] = [];
		let generation = 0;
		const facetLoader: FacetLoader = {
			async load() {
				const current = ++generation;
				return {
					facets: [
						defineFacet({
							id: "reloadable-session-plugin",
							setup(env) {
								env.onActivate(() => {
									activations.push(current);
								});
							},
						}),
					],
					async dispose() {
						disposals.push(current);
					},
				};
			},
		};
		const snapshot: LaneSnapshot = {
			lane: "main",
			transcript: [],
			tipId: null,
			configuration: {
				model: { provider: "test", modelId: "model" },
				thinkingLevel: "off",
				activeToolNames: [],
			},
			stats: {
				messageCount: 0,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
			operation: null,
			queues: [],
			faulted: false,
		};
		const lane = {
			async watch() {
				return {
					snapshot,
					start() {},
					async resnapshot() {
						return snapshot;
					},
					unsubscribe() {},
				};
			},
			async getModel() {
				return undefined;
			},
			async getThinkingLevel() {
				return "off" as const;
			},
		} as unknown as AgentLane;
		const services = await createSessionWorkerServices({
			lane,
			modelRuntime: undefined,
			facetLoader,
			publish: vi.fn(async () => {}),
		});
		try {
			expect(activations).toEqual([1]);
			await services.invoke(
				{ serviceId: SessionPlugins.id, member: "reload", args: [] },
				{ serverConnectionId: "server-1", attachmentId: "attachment-1" },
				BACKGROUND_CONTEXT,
			);
			expect(activations).toEqual([1, 2]);
			expect(disposals).toEqual([1]);
		} finally {
			await services.dispose();
		}
		expect(disposals).toEqual([1, 2]);
	});
});
