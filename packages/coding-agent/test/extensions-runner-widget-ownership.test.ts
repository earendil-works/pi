import { describe, expect, it, vi } from "vitest";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";

function createUIContext(): ExtensionUIContext & {
	setWidget: ReturnType<typeof vi.fn>;
	themeValue: string;
} {
	const setWidget = vi.fn();
	const context = {
		setWidget,
		notify: vi.fn(),
		setStatus: vi.fn(),
		get theme() {
			return context.themeValue;
		},
		themeValue: "base-theme",
	} as unknown as ExtensionUIContext & { setWidget: ReturnType<typeof vi.fn>; themeValue: string };
	return context;
}

function createRuntime(): Record<string, ReturnType<typeof vi.fn>> {
	return {
		invalidate: vi.fn(),
		getActiveTools: vi.fn(() => []),
		on: vi.fn(),
	};
}

function createRunner(): ExtensionRunner {
	return new ExtensionRunner([], createRuntime() as never, "/tmp", vi.fn() as never, vi.fn() as never);
}

describe("extension widget ownership teardown", () => {
	it("force-removes widgets registered through the ctx when the runner is invalidated", () => {
		const runner = createRunner();
		const ui = createUIContext();
		runner.setUIContext(ui, "tui");

		const ctxUI = runner.getUIContext();
		ctxUI.setWidget("usage", ["line"], { placement: "belowEditor" });
		ctxUI.setWidget("status-extra", ["x"]);

		expect(ui.setWidget).toHaveBeenCalledTimes(2);
		expect(runner.hasUI()).toBe(true);

		runner.invalidate();

		// Two explicit registrations, then one removal per owned widget on invalidate.
		const registrations = ui.setWidget.mock.calls.filter(([, content]) => content !== undefined);
		expect(registrations.length).toBe(2);
		const removals = ui.setWidget.mock.calls.filter(([, content]) => content === undefined);
		expect(removals.length).toBe(2);
		expect(removals.map(([key]) => key).sort()).toEqual(["status-extra", "usage"]);
	});

	it("deregistering a widget stops tracking it", () => {
		const runner = createRunner();
		const ui = createUIContext();
		runner.setUIContext(ui, "tui");

		const ctxUI = runner.getUIContext();
		ctxUI.setWidget("usage", ["line"]);
		ctxUI.setWidget("usage", undefined);

		runner.invalidate();

		const removals = ui.setWidget.mock.calls.filter(([, content]) => content === undefined);
		expect(removals.length).toBe(1); // the explicit deregistration only
	});

	it("keeps getters lazy through the wrapper and preserves invalidation idempotency", () => {
		const runner = createRunner();
		const ui = createUIContext();
		runner.setUIContext(ui, "tui");

		const ctxUI = runner.getUIContext() as unknown as { theme: string };
		ui.themeValue = "changed-after-wrapping";
		expect(ctxUI.theme).toBe("changed-after-wrapping");

		runner.invalidate();
		runner.invalidate(); // second call must not re-remove or throw
		expect(ui.setWidget).toHaveBeenCalledTimes(0);
	});

	it("invalidation survives a throwing ui context", () => {
		const runner = createRunner();
		const ui = createUIContext();
		ui.setWidget = vi.fn(() => {
			throw new Error("ui gone");
		}) as never;
		runner.setUIContext(ui, "tui");

		const ctxUI = runner.getUIContext();
		expect(() => ctxUI.setWidget("usage", ["line"])).toThrow("ui gone");

		expect(() => runner.invalidate()).not.toThrow();
	});
});
