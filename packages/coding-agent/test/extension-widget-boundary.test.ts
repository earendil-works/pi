import { describe, expect, it, vi } from "vitest";
import { createExtensionWidgetBoundary } from "../src/modes/interactive/extension-widget-boundary.ts";

function makeComponent(behavior: { render?: (width: number) => string[] }): {
	component: { render: (width: number) => string[]; invalidate: () => void; dispose?: () => void };
	renders: number;
} {
	const renders = { count: 0 };
	const component = {
		render(width: number): string[] {
			renders.count += 1;
			return behavior.render ? behavior.render(width) : ["ok"];
		},
		invalidate: vi.fn(),
		dispose: vi.fn(),
	};
	return { component, renders: renders.count, ...renders } as never;
}

describe("extension widget render boundary", () => {
	it("passes render and invalidate through unchanged for a healthy widget", () => {
		const onDisable = vi.fn();
		const { component } = makeComponent({});
		const bounded = createExtensionWidgetBoundary({ key: "w", component, onDisable });

		expect(bounded.render(80)).toEqual(["ok"]);
		bounded.invalidate();
		expect(component.invalidate).toHaveBeenCalled();
		expect(onDisable).not.toHaveBeenCalled();
	});

	it("disables the widget instead of throwing on a render exception", () => {
		const onDisable = vi.fn();
		const boom = new Error("stale ctx");
		const { component } = makeComponent({
			render: () => {
				throw boom;
			},
		});
		const bounded = createExtensionWidgetBoundary({ key: "w", component, onDisable });

		expect(bounded.render(80)).toEqual([]);
		expect(onDisable).toHaveBeenCalledWith("w", component, boom);
		// Subsequent renders stay empty and do not re-enter the broken widget.
		expect(bounded.render(80)).toEqual([]);
		expect(onDisable).toHaveBeenCalledTimes(1);
	});

	it("renders empty (not throwing) after dispose", () => {
		const onDisable = vi.fn();
		const { component } = makeComponent({});
		const bounded = createExtensionWidgetBoundary({ key: "w", component, onDisable });

		bounded.dispose?.();
		expect(bounded.render(80)).toEqual([]);
		expect(component.dispose).toHaveBeenCalled();
		expect(onDisable).not.toHaveBeenCalled(); // dispose is not a failure
	});

	it("contains a throwing disposer and a throwing invalidator", () => {
		const onDisable = vi.fn();
		const component = {
			render: () => ["x"],
			invalidate: () => {
				throw new Error("invalidate boom");
			},
			dispose: () => {
				throw new Error("dispose boom");
			},
		};
		const bounded = createExtensionWidgetBoundary({ key: "w", component, onDisable });

		expect(() => bounded.invalidate()).not.toThrow();
		expect(bounded.render(80)).toEqual(["x"]); // invalidate failure does not disable
		expect(() => bounded.dispose?.()).not.toThrow();
	});

	it("keeps the widget if onDisable itself throws", () => {
		const onDisable = () => {
			throw new Error("disabler broken");
		};
		const { component } = makeComponent({
			render: () => {
				throw new Error("render boom");
			},
		});
		const bounded = createExtensionWidgetBoundary({ key: "w", component, onDisable });

		expect(bounded.render(80)).toEqual([]); // disabled locally even though disabler threw
	});
});
