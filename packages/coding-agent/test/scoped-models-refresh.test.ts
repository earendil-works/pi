import type { Api, Model, ModelsRefreshOptions, ModelsRefreshResult } from "@earendil-works/pi-ai";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ModelResolver from "../src/core/model-resolver.ts";

const { resolveModelScopeWithDiagnosticsMock } = vi.hoisted(() => ({
	resolveModelScopeWithDiagnosticsMock: vi.fn(),
}));

vi.mock("../src/core/model-resolver.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof ModelResolver>();
	return {
		...actual,
		resolveModelScopeWithDiagnostics: resolveModelScopeWithDiagnosticsMock,
	};
});

import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ScopedModelsSelectorComponent } from "../src/modes/interactive/components/scoped-models-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

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

function model(id: string, name = id): Model<Api> {
	return {
		provider: "faux",
		id,
		name,
		api: "openai-completions",
	} as Model<Api>;
}

function fullId(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function render(selector: ScopedModelsSelectorComponent): string {
	return stripAnsi(selector.render(120).join("\n"));
}

function openScopedModelsSelector(context: object): void {
	Reflect.set(
		context,
		"refreshScopedModelsSelector",
		Reflect.get(InteractiveMode.prototype, "refreshScopedModelsSelector"),
	);
	const show = Reflect.get(InteractiveMode.prototype, "showModelsSelector") as (this: object) => void;
	show.call(context);
}

function createContext(options: {
	snapshot: () => readonly Model<Api>[];
	refresh: (options?: ModelsRefreshOptions) => Promise<ModelsRefreshResult>;
	configuredPatterns?: string[];
	scopedModels?: Array<{
		model: Model<Api>;
		thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	}>;
}) {
	let selector: ScopedModelsSelectorComponent | undefined;
	let disposeSelector: (() => void) | undefined;
	const session = {
		modelRuntime: {
			getAvailableSnapshot: options.snapshot,
			refresh: vi.fn(options.refresh),
			// The selector must not use this moving global runtime view when it applies a callback.
			getAvailable: vi.fn(async () => [model("wrong", "Wrong runtime model")]),
			getError: () => undefined,
		},
		scopedModels: options.scopedModels ?? [],
		setScopedModels: vi.fn(),
	};
	const context = {
		session,
		settingsManager: {
			getEnabledModels: () => options.configuredPatterns,
			setEnabledModels: vi.fn(),
		},
		showStatus: vi.fn(),
		showSelector: (
			factory: (done: () => void) => {
				component: ScopedModelsSelectorComponent;
				dispose?: () => void;
			},
		) => {
			const view = factory(() => {});
			selector = view.component;
			disposeSelector = view.dispose;
			return true;
		},
		updateAvailableProviderCount: vi.fn(async () => {}),
		ui: { requestRender: vi.fn() },
	};
	return {
		context,
		session,
		getSelector: () => selector,
		disposeSelector: () => disposeSelector?.(),
	};
}

describe("/scoped-models cache-first refresh", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(async () => {
		setKeybindings(new KeybindingsManager());
		const { resolveModelScopeWithDiagnostics } = await vi.importActual<typeof ModelResolver>(
			"../src/core/model-resolver.ts",
		);
		resolveModelScopeWithDiagnosticsMock.mockReset();
		resolveModelScopeWithDiagnosticsMock.mockImplementation(resolveModelScopeWithDiagnostics);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("keeps raw wildcard settings until an edit, then combines their resolved models and no-match rows", async () => {
		const alpha = model("alpha", "Alpha cached");
		const refresh = deferred<ModelsRefreshResult>();
		const patterns = ["faux/*:high", "faux/missing"];
		const { context, getSelector } = createContext({
			snapshot: () => [alpha],
			refresh: () => refresh.promise,
			configuredPatterns: patterns,
		});

		openScopedModelsSelector(context);
		const selector = getSelector();
		if (!selector) throw new Error("Expected selector");
		// The mounting view is synchronous and represents the raw settings rather than prematurely materializing a glob.
		expect(render(selector)).toContain("faux/*:high [unavailable]");
		await vi.waitFor(() => {
			expect(render(selector)).toContain("alpha [faux] ✓");
			expect(render(selector)).toContain("faux/missing [unavailable] ✗");
		});
		selector.handleInput("\x13");
		expect(context.settingsManager.setEnabledModels).toHaveBeenLastCalledWith(patterns);
		selector.handleInput("\x1b[1;3B");
		selector.handleInput("\x13");
		expect(context.settingsManager.setEnabledModels).toHaveBeenLastCalledWith(["faux/missing", "faux/alpha:high"]);
		refresh.resolve({ aborted: true, errors: new Map() });
	});

	it("keeps wildcard thinking levels through a resolved edit without broadening the session scope", async () => {
		const alpha = model("alpha");
		const beta = model("beta");
		const refresh = deferred<ModelsRefreshResult>();
		const { context, session, getSelector } = createContext({
			snapshot: () => [alpha, beta],
			refresh: () => refresh.promise,
			configuredPatterns: ["faux/*:high"],
		});

		openScopedModelsSelector(context);
		const selector = getSelector();
		if (!selector) throw new Error("Expected selector");
		await vi.waitFor(() => {
			expect(render(selector)).toContain("alpha [faux] ✓");
			expect(render(selector)).toContain("beta [faux] ✓");
		});

		selector.handleInput("\x1b[1;3B");
		await vi.waitFor(() => {
			expect(session.setScopedModels).toHaveBeenLastCalledWith([
				{ model: beta, thinkingLevel: "high" },
				{ model: alpha, thinkingLevel: "high" },
			]);
		});
		expect(session.setScopedModels).not.toHaveBeenLastCalledWith([]);

		selector.handleInput("\x13");
		expect(context.settingsManager.setEnabledModels).toHaveBeenLastCalledWith(["faux/beta:high", "faux/alpha:high"]);
		refresh.resolve({ aborted: true, errors: new Map() });
	});

	it("saves an untouched session scope with its thinking level instead of configured settings", async () => {
		const configured = model("configured");
		const session = model("session");
		const refresh = deferred<ModelsRefreshResult>();
		const { context, getSelector } = createContext({
			snapshot: () => [configured, session],
			refresh: () => refresh.promise,
			configuredPatterns: [fullId(configured)],
			scopedModels: [{ model: session, thinkingLevel: "high" }],
		});

		openScopedModelsSelector(context);
		const selector = getSelector();
		if (!selector) throw new Error("Expected selector");
		selector.handleInput("\x13");

		expect(context.settingsManager.setEnabledModels).toHaveBeenLastCalledWith(["faux/session:high"]);
		refresh.resolve({ aborted: true, errors: new Map() });
	});

	it("does not clear an existing session scope for an empty catalog or an unresolved-only selection", async () => {
		const prior = model("prior");
		const refresh = deferred<ModelsRefreshResult>();
		const { context, session, getSelector } = createContext({
			snapshot: () => [],
			refresh: () => refresh.promise,
			configuredPatterns: ["faux/missing"],
			scopedModels: [{ model: prior }],
		});

		openScopedModelsSelector(context);
		const selector = getSelector();
		if (!selector) throw new Error("Expected selector");
		expect(render(selector)).toContain("faux/prior [unavailable] ✗");
		selector.handleInput("\r");
		await Promise.resolve();
		expect(session.setScopedModels).not.toHaveBeenCalled();
		refresh.resolve({ aborted: false, errors: new Map() });
		await Promise.resolve();
		expect(session.setScopedModels).not.toHaveBeenCalled();
	});

	it("keeps a scope containing every available model plus an unresolved pattern", async () => {
		const alpha = model("alpha");
		const refresh = deferred<ModelsRefreshResult>();
		const patterns = [fullId(alpha), "faux/missing"];
		const { context, session, getSelector } = createContext({
			snapshot: () => [alpha],
			refresh: () => refresh.promise,
			configuredPatterns: patterns,
		});

		openScopedModelsSelector(context);
		const selector = getSelector();
		if (!selector) throw new Error("Expected selector");
		await vi.waitFor(() => expect(render(selector)).toContain("faux/missing [unavailable] ✗"));
		// Reordering is an intentional edit, so the wildcard/ID representation may materialize but the unresolved row remains.
		selector.handleInput("\x1b[1;3B");
		await vi.waitFor(() => expect(session.setScopedModels).toHaveBeenLastCalledWith([{ model: alpha }]));
		selector.handleInput("\x13");
		expect(context.settingsManager.setEnabledModels).toHaveBeenLastCalledWith(["faux/missing", fullId(alpha)]);
		refresh.resolve({ aborted: true, errors: new Map() });
	});

	it("preserves thinking level when a callback uses refreshed model objects", async () => {
		const alpha = model("alpha", "Alpha cached");
		const beta = model("beta", "Beta cached");
		const refreshedAlpha = model("alpha", "Alpha refreshed");
		const refreshedBeta = model("beta", "Beta refreshed");
		const gamma = model("gamma", "Gamma refreshed");
		let snapshot: readonly Model<Api>[] = [alpha, beta];
		const refresh = deferred<ModelsRefreshResult>();
		const { context, session, getSelector } = createContext({
			snapshot: () => snapshot,
			refresh: () => refresh.promise,
			scopedModels: [
				{ model: alpha, thinkingLevel: "high" },
				{ model: beta, thinkingLevel: "low" },
			],
		});

		openScopedModelsSelector(context);
		const selector = getSelector();
		if (!selector) throw new Error("Expected selector");
		snapshot = [refreshedAlpha, refreshedBeta, gamma];
		refresh.resolve({ aborted: false, errors: new Map() });
		await vi.waitFor(() => expect(render(selector)).toContain("Model Name: Alpha refreshed"));
		selector.handleInput("\x1b[1;3B");
		await vi.waitFor(() => {
			expect(session.setScopedModels).toHaveBeenLastCalledWith([
				{ model: refreshedBeta, thinkingLevel: "low" },
				{ model: refreshedAlpha, thinkingLevel: "high" },
			]);
		});
		selector.handleInput("\x13");
		expect(context.settingsManager.setEnabledModels).toHaveBeenLastCalledWith(["faux/beta:low", "faux/alpha:high"]);
	});

	it("uses the refreshed selector catalog rather than a newer runtime catalog in callbacks", async () => {
		const alpha = model("alpha", "Alpha cached");
		const beta = model("beta", "Beta cached");
		const refreshedAlpha = model("alpha", "Alpha refreshed");
		const refreshedBeta = model("beta", "Beta refreshed");
		const gamma = model("gamma", "Gamma refreshed");
		let snapshot: readonly Model<Api>[] = [alpha, beta];
		const refresh = deferred<ModelsRefreshResult>();
		const { context, session, getSelector } = createContext({
			snapshot: () => snapshot,
			refresh: () => refresh.promise,
			scopedModels: [{ model: alpha }],
		});

		openScopedModelsSelector(context);
		const selector = getSelector();
		if (!selector) throw new Error("Expected selector");
		snapshot = [refreshedAlpha, refreshedBeta, gamma];
		refresh.resolve({ aborted: false, errors: new Map() });
		await vi.waitFor(() => expect(render(selector)).toContain("Model Name: Alpha refreshed"));
		selector.handleInput("\x1b[B");
		selector.handleInput("\r");
		await vi.waitFor(() => {
			expect(session.setScopedModels).toHaveBeenLastCalledWith([
				{ model: refreshedAlpha },
				{ model: refreshedBeta },
			]);
		});
		expect(session.modelRuntime.getAvailable).not.toHaveBeenCalled();
	});

	it("serializes rapid changes so the latest reordered scope wins", async () => {
		const alpha = model("alpha");
		const beta = model("beta");
		const gamma = model("gamma");
		const delta = model("delta");
		const refresh = deferred<ModelsRefreshResult>();
		const { context, session, getSelector } = createContext({
			snapshot: () => [alpha, beta, gamma, delta],
			refresh: () => refresh.promise,
			scopedModels: [{ model: alpha }, { model: beta }, { model: gamma }],
		});

		openScopedModelsSelector(context);
		const selector = getSelector();
		if (!selector) throw new Error("Expected selector");
		selector.handleInput("\x1b[1;3B");
		selector.handleInput("\x1b[1;3B");
		await vi.waitFor(() => {
			expect(session.setScopedModels).toHaveBeenLastCalledWith([
				{ model: beta },
				{ model: gamma },
				{ model: alpha },
			]);
		});
		refresh.resolve({ aborted: true, errors: new Map() });
	});

	it("keeps the refreshed configured resolution when the cached resolution finishes last", async () => {
		const alpha = model("alpha", "Alpha cached");
		const beta = model("beta", "Beta refreshed");
		let snapshot: readonly Model<Api>[] = [alpha];
		const cachedResolution = deferred<{
			scopedModels: Array<{ model: Model<Api>; thinkingLevel?: "high" }>;
			diagnostics: [];
		}>();
		const refreshedResolution = deferred<{
			scopedModels: Array<{ model: Model<Api>; thinkingLevel?: "high" }>;
			diagnostics: [];
		}>();
		resolveModelScopeWithDiagnosticsMock
			.mockReturnValueOnce(cachedResolution.promise)
			.mockReturnValueOnce(refreshedResolution.promise);
		const { context, session, getSelector } = createContext({
			snapshot: () => snapshot,
			refresh: async () => {
				snapshot = [beta];
				return { aborted: false, errors: new Map() };
			},
			configuredPatterns: ["faux/*:high"],
		});

		openScopedModelsSelector(context);
		const selector = getSelector();
		if (!selector) throw new Error("Expected selector");
		await vi.waitFor(() => expect(resolveModelScopeWithDiagnosticsMock).toHaveBeenCalledTimes(2));

		refreshedResolution.resolve({
			scopedModels: [{ model: beta, thinkingLevel: "high" }],
			diagnostics: [],
		});
		await vi.waitFor(() => expect(render(selector)).toContain("→ beta [faux] ✓"));
		cachedResolution.resolve({
			scopedModels: [{ model: alpha, thinkingLevel: "high" }],
			diagnostics: [],
		});
		await cachedResolution.promise;
		await Promise.resolve();

		expect(render(selector)).toContain("→ beta [faux] ✓");
		expect(render(selector)).not.toContain("alpha [unavailable] ✓");
		selector.handleInput("\r");
		selector.handleInput("\r");
		await vi.waitFor(() =>
			expect(session.setScopedModels).toHaveBeenLastCalledWith([{ model: beta, thinkingLevel: "high" }]),
		);
		selector.handleInput("\x13");
		expect(context.settingsManager.setEnabledModels).toHaveBeenLastCalledWith(["faux/beta:high"]);
	});

	it("applies cached resolution before the refreshed resolution replaces it", async () => {
		const alpha = model("alpha", "Alpha cached");
		const beta = model("beta", "Beta refreshed");
		let snapshot: readonly Model<Api>[] = [alpha];
		const catalogRefresh = deferred<ModelsRefreshResult>();
		const cachedResolution = deferred<{
			scopedModels: Array<{ model: Model<Api>; thinkingLevel?: "high" }>;
			diagnostics: [];
		}>();
		const refreshedResolution = deferred<{
			scopedModels: Array<{ model: Model<Api>; thinkingLevel?: "high" }>;
			diagnostics: [];
		}>();
		resolveModelScopeWithDiagnosticsMock
			.mockReturnValueOnce(cachedResolution.promise)
			.mockReturnValueOnce(refreshedResolution.promise);
		const { context, session, getSelector } = createContext({
			snapshot: () => snapshot,
			refresh: () => catalogRefresh.promise,
			configuredPatterns: ["faux/*:high"],
		});

		openScopedModelsSelector(context);
		const selector = getSelector();
		if (!selector) throw new Error("Expected selector");
		await vi.waitFor(() => expect(resolveModelScopeWithDiagnosticsMock).toHaveBeenCalledTimes(1));

		cachedResolution.resolve({
			scopedModels: [{ model: alpha, thinkingLevel: "high" }],
			diagnostics: [],
		});
		await vi.waitFor(() => expect(render(selector)).toContain("→ alpha [faux] ✓"));
		snapshot = [beta];
		catalogRefresh.resolve({ aborted: false, errors: new Map() });
		await vi.waitFor(() => expect(resolveModelScopeWithDiagnosticsMock).toHaveBeenCalledTimes(2));
		refreshedResolution.resolve({
			scopedModels: [{ model: beta, thinkingLevel: "high" }],
			diagnostics: [],
		});
		await vi.waitFor(() => expect(render(selector)).toContain("→ beta [faux] ✓"));

		expect(render(selector)).not.toContain("alpha [unavailable] ✓");
		selector.handleInput("\r");
		selector.handleInput("\r");
		await vi.waitFor(() =>
			expect(session.setScopedModels).toHaveBeenLastCalledWith([{ model: beta, thinkingLevel: "high" }]),
		);
		selector.handleInput("\x13");
		expect(context.settingsManager.setEnabledModels).toHaveBeenLastCalledWith(["faux/beta:high"]);
	});

	it("shows a stable TUI error without secret-bearing refresh exception text", async () => {
		const alpha = model("alpha");
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const unhandledRejection = vi.fn();
		const onUnhandledRejection = (reason: unknown) => unhandledRejection(reason);
		process.on("unhandledRejection", onUnhandledRejection);
		const { context, getSelector } = createContext({
			snapshot: () => [alpha],
			refresh: async () => {
				throw new Error("secret-token-refresh");
			},
		});

		try {
			openScopedModelsSelector(context);
			const selector = getSelector();
			if (!selector) throw new Error("Expected selector");
			await vi.waitFor(() => {
				expect(render(selector)).toContain("Could not refresh model catalogs; showing cached models.");
			});
			const view = render(selector);
			expect(view).not.toContain("secret-token-refresh");
			expect(view).not.toContain("Refreshing model catalogs\u2026");
			expect(context.ui.requestRender).toHaveBeenCalled();
			for (const call of consoleError.mock.calls) {
				expect(call.join(" ")).not.toContain("secret-token-refresh");
			}
			expect(unhandledRejection).not.toHaveBeenCalled();
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}
	});

	it("keeps the refreshed selector usable when configured scope resolution fails", async () => {
		const alpha = model("alpha");
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const unhandledRejection = vi.fn();
		const onUnhandledRejection = (reason: unknown) => unhandledRejection(reason);
		process.on("unhandledRejection", onUnhandledRejection);
		const { resolveModelScopeWithDiagnostics } = await vi.importActual<typeof ModelResolver>(
			"../src/core/model-resolver.ts",
		);
		resolveModelScopeWithDiagnosticsMock
			.mockImplementationOnce(resolveModelScopeWithDiagnostics)
			.mockRejectedValueOnce(new Error("secret-token-resolver"));
		const { context, session, getSelector } = createContext({
			snapshot: () => [alpha],
			refresh: async () => ({ aborted: false, errors: new Map() }),
			configuredPatterns: [fullId(alpha)],
		});

		try {
			openScopedModelsSelector(context);
			const selector = getSelector();
			if (!selector) throw new Error("Expected selector");
			await vi.waitFor(() => {
				expect(render(selector)).toContain("Could not resolve configured model scope; showing current models.");
			});
			const view = render(selector);
			expect(view).not.toContain("secret-token-resolver");
			expect(view).not.toContain("Refreshing model catalogs\u2026");
			expect(context.ui.requestRender).toHaveBeenCalled();
			expect(consoleError).toHaveBeenCalledWith("Could not resolve configured model scope from refreshed catalog.");
			for (const call of consoleError.mock.calls) {
				expect(call.join(" ")).not.toContain("secret-token-resolver");
			}
			expect(unhandledRejection).not.toHaveBeenCalled();

			selector.handleInput("\r");
			await vi.waitFor(() => expect(session.setScopedModels).toHaveBeenLastCalledWith([]));
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}
	});

	it("handles configured scope resolution failure after timeout without an unhandled rejection", async () => {
		vi.useFakeTimers();
		const alpha = model("alpha");
		const completion = deferred<ModelsRefreshResult>();
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const unhandledRejection = vi.fn();
		const onUnhandledRejection = (reason: unknown) => unhandledRejection(reason);
		process.on("unhandledRejection", onUnhandledRejection);
		try {
			const { resolveModelScopeWithDiagnostics } = await vi.importActual<typeof ModelResolver>(
				"../src/core/model-resolver.ts",
			);
			resolveModelScopeWithDiagnosticsMock
				.mockImplementationOnce(resolveModelScopeWithDiagnostics)
				.mockRejectedValueOnce(new Error("secret-token-resolver"));
			const { context, session, getSelector } = createContext({
				snapshot: () => [alpha],
				refresh: () => completion.promise,
				configuredPatterns: [fullId(alpha)],
			});

			openScopedModelsSelector(context);
			const selector = getSelector();
			if (!selector) throw new Error("Expected selector");
			await vi.advanceTimersByTimeAsync(15_000);
			await Promise.resolve();

			const view = render(selector);
			expect(view).toContain("Model refresh timed out; showing cached models.");
			expect(view).toContain("Could not resolve configured model scope; showing current models.");
			expect(view).not.toContain("secret-token-resolver");
			expect(view).not.toContain("Refreshing model catalogs\u2026");
			expect(context.ui.requestRender).toHaveBeenCalled();
			expect(consoleError).toHaveBeenCalledWith("Could not resolve configured model scope from refreshed catalog.");
			for (const call of consoleError.mock.calls) {
				expect(call.join(" ")).not.toContain("secret-token-resolver");
			}
			expect(unhandledRejection).not.toHaveBeenCalled();

			selector.handleInput("\r");
			await vi.waitFor(() => expect(session.setScopedModels).toHaveBeenLastCalledWith([]));
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}
	});

	it("does not apply configured resolution after selector disposal", async () => {
		const alpha = model("alpha");
		const configuredResolution = deferred<{
			scopedModels: Array<{ model: Model<Api>; thinkingLevel?: "high" }>;
			diagnostics: [];
		}>();
		const refresh = deferred<ModelsRefreshResult>();
		const { context, getSelector, disposeSelector } = createContext({
			snapshot: () => [alpha],
			refresh: () => refresh.promise,
			configuredPatterns: ["faux/*:high"],
		});
		resolveModelScopeWithDiagnosticsMock.mockReturnValueOnce(configuredResolution.promise);

		openScopedModelsSelector(context);
		const selector = getSelector();
		if (!selector) throw new Error("Expected selector");
		const applyResolved = vi.spyOn(selector, "applyResolvedEnabledModelIds");
		context.ui.requestRender.mockClear();
		disposeSelector();
		configuredResolution.resolve({
			scopedModels: [{ model: alpha, thinkingLevel: "high" }],
			diagnostics: [],
		});
		await configuredResolution.promise;
		await Promise.resolve();

		expect(applyResolved).not.toHaveBeenCalled();
		expect(context.ui.requestRender).not.toHaveBeenCalled();
		refresh.resolve({ aborted: true, errors: new Map() });
	});

	it("does not update the session after a queued selection resolution is disposed", async () => {
		const alpha = model("alpha");
		const beta = model("beta");
		const gamma = model("gamma");
		const selectionResolution = deferred<{
			scopedModels: Array<{ model: Model<Api> }>;
			diagnostics: [];
		}>();
		const refresh = deferred<ModelsRefreshResult>();
		const { context, session, getSelector, disposeSelector } = createContext({
			snapshot: () => [alpha, beta, gamma],
			refresh: () => refresh.promise,
			scopedModels: [{ model: alpha }, { model: beta }],
		});

		openScopedModelsSelector(context);
		const selector = getSelector();
		if (!selector) throw new Error("Expected selector");
		resolveModelScopeWithDiagnosticsMock.mockReturnValueOnce(selectionResolution.promise);
		context.ui.requestRender.mockClear();
		selector.handleInput("\x1b[1;3B");
		await vi.waitFor(() => expect(resolveModelScopeWithDiagnosticsMock).toHaveBeenCalled());
		disposeSelector();
		selectionResolution.resolve({
			scopedModels: [{ model: beta }, { model: alpha }],
			diagnostics: [],
		});
		await selectionResolution.promise;
		await Promise.resolve();

		expect(session.setScopedModels).not.toHaveBeenCalled();
		expect(context.ui.requestRender).not.toHaveBeenCalled();
		refresh.resolve({ aborted: true, errors: new Map() });
	});

	it("applies a timeout exactly once and ignores a late completion or a disposed selector", async () => {
		vi.useFakeTimers();
		const cached = model("cached");
		const late = model("late");
		let snapshot: readonly Model<Api>[] = [cached];
		const completion = deferred<ModelsRefreshResult>();
		const { context, getSelector } = createContext({
			snapshot: () => snapshot,
			refresh: () => completion.promise,
		});

		openScopedModelsSelector(context);
		const selector = getSelector();
		if (!selector) throw new Error("Expected selector");
		await vi.advanceTimersByTimeAsync(15_000);
		expect(render(selector)).toContain("Model refresh timed out; showing cached models.");
		snapshot = [late];
		completion.resolve({ aborted: false, errors: new Map() });
		await Promise.resolve();
		expect(render(selector)).toContain("Model refresh timed out; showing cached models.");

		const lateAfterDispose = deferred<ModelsRefreshResult>();
		const disposedContext = createContext({
			snapshot: () => [cached],
			refresh: () => lateAfterDispose.promise,
		});
		openScopedModelsSelector(disposedContext.context);
		const disposed = disposedContext.getSelector();
		if (!disposed) throw new Error("Expected selector");
		const renderedBeforeDispose = render(disposed);
		disposed.dispose();
		await vi.advanceTimersByTimeAsync(15_000);
		lateAfterDispose.resolve({ aborted: false, errors: new Map() });
		await Promise.resolve();
		expect(render(disposed)).toBe(renderedBeforeDispose);
		expect(disposedContext.context.ui.requestRender).not.toHaveBeenCalled();
	});
});
