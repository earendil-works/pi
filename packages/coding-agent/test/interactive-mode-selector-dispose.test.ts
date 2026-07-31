import type { ModelsRefreshOptions, ModelsRefreshResult } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { SelectorOwnership } from "../src/modes/interactive/selector-ownership.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createFakeTui(requestRender: () => void): TUI {
	return { requestRender } as unknown as TUI;
}

function render(selector: ModelSelectorComponent): string {
	return stripAnsi(selector.render(120).join("\n"));
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

describe("ModelSelectorComponent refresh deadline", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("stops waiting at 15s, shows timeout with cached models, and ignores late completion", async () => {
		const harness = await createHarness({ models: [{ id: "cached", name: "Cached Model", reasoning: true }] });
		harnesses.push(harness);
		const completion = deferred<ModelsRefreshResult>();
		let refreshSignal: AbortSignal | undefined;
		vi.spyOn(harness.session.modelRuntime, "refresh").mockImplementation((options: ModelsRefreshOptions = {}) => {
			refreshSignal = options.signal;
			return completion.promise;
		});
		const requestRender = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(requestRender),
			harness.getModel(),
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		expect(render(selector)).toContain("Refreshing model catalogs…");
		expect(render(selector)).toContain("cached");
		expect(refreshSignal?.aborted).toBe(false);
		requestRender.mockClear();

		await vi.advanceTimersByTimeAsync(15_000);
		await Promise.resolve();

		const afterTimeout = render(selector);
		expect(afterTimeout).toContain("Model refresh timed out; showing cached models.");
		expect(afterTimeout).toContain("cached");
		expect(afterTimeout).not.toContain("Refreshing model catalogs…");
		expect(refreshSignal?.aborted).toBe(true);
		expect(requestRender).toHaveBeenCalled();

		// Late success must not overwrite the timeout UI.
		requestRender.mockClear();
		completion.resolve({ aborted: false, errors: new Map() });
		await completion.promise;
		await Promise.resolve();
		await Promise.resolve();

		expect(render(selector)).toContain("Model refresh timed out; showing cached models.");
		expect(render(selector)).not.toContain("Model catalogs refreshed.");
		expect(render(selector)).not.toContain("Refreshing model catalogs…");
		expect(requestRender).not.toHaveBeenCalled();

		selector.dispose();
	});

	it("does not mutate after dispose even if the deadline fires later", async () => {
		const harness = await createHarness({ models: [{ id: "cached", name: "Cached Model", reasoning: true }] });
		harnesses.push(harness);
		const completion = deferred<ModelsRefreshResult>();
		vi.spyOn(harness.session.modelRuntime, "refresh").mockImplementation(() => completion.promise);
		const requestRender = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(requestRender),
			harness.getModel(),
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);
		const before = render(selector);
		requestRender.mockClear();
		selector.dispose();
		await vi.advanceTimersByTimeAsync(15_000);
		completion.resolve({ aborted: false, errors: new Map() });
		await completion.promise;
		await Promise.resolve();

		expect(render(selector)).toBe(before);
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("clears refreshing and shows a stable cached-model error when refresh rejects early", async () => {
		const harness = await createHarness({ models: [{ id: "cached", name: "Cached Model", reasoning: true }] });
		harnesses.push(harness);
		const completion = deferred<ModelsRefreshResult>();
		vi.spyOn(harness.session.modelRuntime, "refresh").mockImplementation(() => completion.promise);
		const requestRender = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(requestRender),
			harness.getModel(),
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		expect(render(selector)).toContain("Refreshing model catalogs…");
		requestRender.mockClear();

		completion.reject(new Error("provider network blew up with secrets"));
		await completion.promise.catch(() => {});
		await Promise.resolve();
		await Promise.resolve();

		const afterReject = render(selector);
		expect(afterReject).toContain("Could not refresh model catalogs; showing cached models.");
		expect(afterReject).toContain("cached");
		expect(afterReject).not.toContain("Refreshing model catalogs…");
		expect(afterReject).not.toContain("provider network blew up with secrets");
		expect(requestRender).toHaveBeenCalled();

		selector.dispose();
	});

	it("consumes a late rejection after timeout without mutating UI", async () => {
		const harness = await createHarness({ models: [{ id: "cached", name: "Cached Model", reasoning: true }] });
		harnesses.push(harness);
		const completion = deferred<ModelsRefreshResult>();
		vi.spyOn(harness.session.modelRuntime, "refresh").mockImplementation(() => completion.promise);
		const requestRender = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(requestRender),
			harness.getModel(),
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		await vi.advanceTimersByTimeAsync(15_000);
		await Promise.resolve();
		const afterTimeout = render(selector);
		expect(afterTimeout).toContain("Model refresh timed out; showing cached models.");
		requestRender.mockClear();

		completion.reject(new Error("late provider failure"));
		await completion.promise.catch(() => {});
		await Promise.resolve();
		await Promise.resolve();

		expect(render(selector)).toBe(afterTimeout);
		expect(render(selector)).toContain("Model refresh timed out; showing cached models.");
		expect(render(selector)).not.toContain("Could not refresh model catalogs; showing cached models.");
		expect(requestRender).not.toHaveBeenCalled();

		selector.dispose();
	});

	it("consumes a late rejection after dispose without mutating UI", async () => {
		const harness = await createHarness({ models: [{ id: "cached", name: "Cached Model", reasoning: true }] });
		harnesses.push(harness);
		const completion = deferred<ModelsRefreshResult>();
		vi.spyOn(harness.session.modelRuntime, "refresh").mockImplementation(() => completion.promise);
		const requestRender = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(requestRender),
			harness.getModel(),
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);
		const before = render(selector);
		requestRender.mockClear();
		selector.dispose();

		completion.reject(new Error("late after dispose"));
		await completion.promise.catch(() => {});
		await Promise.resolve();
		await Promise.resolve();

		expect(render(selector)).toBe(before);
		expect(requestRender).not.toHaveBeenCalled();
	});
});
