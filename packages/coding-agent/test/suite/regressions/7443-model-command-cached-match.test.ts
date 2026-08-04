import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

const findExactModelMatch = Reflect.get(InteractiveMode.prototype, "findExactModelMatch") as (
	this: object,
	searchTerm: string,
) => Promise<Model<Api> | undefined>;

describe("issue #7443 /model cached match", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		vi.restoreAllMocks();
	});

	it("matches the availability snapshot without starting a catalog refresh", async () => {
		harness = await createHarness({ models: [{ id: "cached", name: "Cached" }] });
		const refresh = vi.spyOn(harness.session.modelRuntime, "refresh").mockImplementation(() => new Promise(() => {}));
		const context = { session: harness.session, showStatus: vi.fn(), showWarning: vi.fn() };

		const model = await findExactModelMatch.call(context, harness.models[0].id);

		expect(model?.id).toBe("cached");
		expect(refresh).not.toHaveBeenCalled();
		expect(context.showStatus).not.toHaveBeenCalled();
	});

	it("uses a caller-owned deadline only after a cache miss", async () => {
		harness = await createHarness({ models: [{ id: "cached", name: "Cached" }] });
		const refresh = vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({
			aborted: true,
			errors: new Map(),
		});
		const context = { session: harness.session, showStatus: vi.fn(), showWarning: vi.fn() };

		await expect(findExactModelMatch.call(context, "not-cached")).resolves.toBeUndefined();

		expect(refresh).toHaveBeenCalledOnce();
		expect(refresh.mock.calls[0]?.[0]?.signal).toBeInstanceOf(AbortSignal);
		expect(context.showStatus).toHaveBeenCalledWith("Refreshing model catalogs…");
	});
});
