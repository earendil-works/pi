import type { ModelsRefreshOptions, ModelsRefreshResult } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { SelectorOwnership } from "../src/modes/interactive/selector-ownership.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function createFakeTui(requestRender: () => void): TUI {
	return { requestRender } as unknown as TUI;
}

describe("ModelSelectorComponent.dispose", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	afterAll(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("aborts only its own refresh and ignores a late completion", async () => {
		const harness = await createHarness({ models: [{ id: "model", name: "Model", reasoning: true }] });
		harnesses.push(harness);
		const refreshes: Array<{ signal: AbortSignal | undefined; completion: Deferred<ModelsRefreshResult> }> = [];
		vi.spyOn(harness.session.modelRuntime, "refresh").mockImplementation((options: ModelsRefreshOptions = {}) => {
			const completion = deferred<ModelsRefreshResult>();
			refreshes.push({ signal: options.signal, completion });
			return completion.promise;
		});
		const firstRender = vi.fn();
		const secondRender = vi.fn();
		const currentModel = harness.getModel();
		const first = new ModelSelectorComponent(
			createFakeTui(firstRender),
			currentModel,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);
		const second = new ModelSelectorComponent(
			createFakeTui(secondRender),
			currentModel,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);
		const ownership = new SelectorOwnership(
			() => {},
			() => {},
		);
		ownership.show(() => ({ component: first, focus: first, dispose: () => first.dispose() }));
		ownership.show(() => ({ component: second, focus: second, dispose: () => second.dispose() }));
		await vi.waitFor(() => expect(refreshes).toHaveLength(2));
		firstRender.mockClear();
		secondRender.mockClear();

		expect(refreshes[0].signal?.aborted).toBe(true);
		expect(refreshes[1].signal?.aborted).toBe(false);

		refreshes[0].completion.resolve({ aborted: true, errors: new Map() });
		await refreshes[0].completion.promise;
		await Promise.resolve();
		await Promise.resolve();
		expect(firstRender).not.toHaveBeenCalled();
		expect(secondRender).not.toHaveBeenCalled();

		second.dispose();
		second.dispose();
		expect(refreshes[1].signal?.aborted).toBe(true);
	});
});
