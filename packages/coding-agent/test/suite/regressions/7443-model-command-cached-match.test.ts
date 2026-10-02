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

	// #10353: Scoped models must follow current workspace availability after a credential change.
	it("rejects stale scoped matches and hides models until availability is verified", async () => {
		harness = await createHarness({ models: [{ id: "workspace-a" }, { id: "workspace-b" }] });
		harness.session.setScopedModels(harness.models.map((model) => ({ model })));
		const snapshot = vi
			.spyOn(harness.session.modelRuntime, "getAvailableSnapshot")
			.mockReturnValue([harness.models[0]]);
		const refresh = vi.spyOn(harness.session.modelRuntime, "refresh");
		const context = { session: harness.session, showStatus: vi.fn(), showWarning: vi.fn() };

		await expect(findExactModelMatch.call(context, "workspace-a")).resolves.toBe(harness.models[0]);
		snapshot.mockReturnValue([harness.models[1]]);
		await expect(findExactModelMatch.call(context, "workspace-a")).resolves.toBeUndefined();
		await expect(findExactModelMatch.call(context, "workspace-b")).resolves.toBe(harness.models[1]);
		snapshot.mockReturnValue([]);
		await expect(findExactModelMatch.call(context, "workspace-b")).resolves.toBeUndefined();

		expect(refresh).not.toHaveBeenCalled();
		expect(context.showStatus).not.toHaveBeenCalled();
	});

	// #10353: A different provider with the same ID must not authorize a stale scoped model.
	it("matches scoped availability by provider as well as model ID", async () => {
		harness = await createHarness({ models: [{ id: "shared-id" }] });
		harness.session.setScopedModels([{ model: harness.models[0] }]);
		vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockReturnValue([
			{ ...harness.models[0], provider: "another-provider" },
		]);
		const context = { session: harness.session, showStatus: vi.fn(), showWarning: vi.fn() };

		await expect(findExactModelMatch.call(context, "shared-id")).resolves.toBeUndefined();
	});

	// #10353: An available scoped match must use refreshed metadata instead of the stale scope object.
	it("returns current metadata for an available scoped match", async () => {
		harness = await createHarness({ models: [{ id: "scoped", name: "Previous metadata" }] });
		harness.session.setScopedModels([{ model: harness.models[0] }]);
		const current = { ...harness.models[0], name: "Refreshed metadata" };
		vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockReturnValue([current]);
		const context = { session: harness.session, showStatus: vi.fn(), showWarning: vi.fn() };

		await expect(findExactModelMatch.call(context, "scoped")).resolves.toBe(current);
	});
});
