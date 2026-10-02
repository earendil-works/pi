import { defineFacet, type FacetLoader } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, test, vi } from "vitest";
import { SessionPlugins } from "../src/experimental/services/plugins.ts";
import { createSessionWorkerServices } from "../src/experimental/services/worker.ts";
import { openFauxConversation } from "./experimental-durable-support.ts";

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
		const { harness, conversation, close } = await openFauxConversation();
		const services = await createSessionWorkerServices({
			harness,
			conversation,
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
			await close();
		}
		expect(disposals).toEqual([1, 2]);
	});
});
