import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

const findExactModelMatch = Reflect.get(InteractiveMode.prototype, "findExactModelMatch") as (
	this: object,
	searchTerm: string,
) => Promise<Model<Api> | undefined>;

describe("issue #7443 /model <name> with an unreachable catalog", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		vi.restoreAllMocks();
	});

	it("matches a cached model without waiting for a stalled refresh", async () => {
		harness = await createHarness({ models: [{ id: "cached", name: "Cached" }] });
		vi.spyOn(harness.session.modelRuntime, "refresh").mockImplementation(() => new Promise(() => {}));
		const boundedRefresh = vi.spyOn(harness.session.modelRuntime, "boundedRefresh");

		const model = await findExactModelMatch.call({ session: harness.session }, harness.models[0].id);

		expect(model?.id).toBe("cached");
		expect(boundedRefresh).not.toHaveBeenCalled();
	});

	it("refreshes through the bounded path when the name is not cached", async () => {
		harness = await createHarness({ models: [{ id: "cached", name: "Cached" }] });
		const refresh = vi.spyOn(harness.session.modelRuntime, "refresh");
		const boundedRefresh = vi.spyOn(harness.session.modelRuntime, "boundedRefresh").mockResolvedValue({
			aborted: true,
			timedOut: true,
			errors: new Map(),
		});
		const context = { session: harness.session, showStatus: vi.fn() };

		await expect(findExactModelMatch.call(context, "not-cached")).resolves.toBeUndefined();

		expect(boundedRefresh).toHaveBeenCalledOnce();
		expect(refresh).not.toHaveBeenCalled();
		expect(context.showStatus).toHaveBeenCalledWith("Refreshing model catalogs…");
	});
});
