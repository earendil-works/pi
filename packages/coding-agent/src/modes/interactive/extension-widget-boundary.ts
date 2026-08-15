import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "./theme/theme.ts";

/**
 * Wraps an extension widget component with a render error boundary.
 *
 * The TUI render timer has no error boundary of its own: an exception thrown
 * from any widget's render() escapes into an uncaughtException and kills the
 * whole process. That is the worst possible failure mode for UI chrome — a
 * single buggy extension widget takes down an interactive session, including
 * all unsaved operator state in flight.
 *
 * A widget that throws during render is disabled (removed via `onDisable`)
 * and renders no lines from then on. Returning an empty array is
 * contract-safe: Container.render simply concatenates child lines.
 */
export function createExtensionWidgetBoundary(options: {
	key: string;
	component: Component & { dispose?(): void };
	onDisable: (key: string, component: Component & { dispose?(): void }, error: unknown) => void;
}): Component & { dispose?(): void } {
	const { key, component, onDisable } = options;
	let disabled = false;

	const disable = (error: unknown): void => {
		if (disabled) return;
		disabled = true;
		try {
			onDisable(key, component, error);
		} catch {
			// The disabler itself must not turn a widget failure into a crash.
		}
	};

	return {
		render(width: number): string[] {
			if (disabled) return [];
			try {
				return component.render(width);
			} catch (error) {
				disable(error);
				return [];
			}
		},
		invalidate(): void {
			if (disabled) return;
			try {
				component.invalidate?.();
			} catch {
				// A throwing invalidate must not escalate either; keep the widget
				// installed and let the render boundary handle persistent failure.
			}
		},
		dispose(): void {
			disabled = true;
			try {
				component.dispose?.();
			} catch {
				// Best-effort cleanup.
			}
		},
	};
}

/** Utility type re-export so callers can reference the widget factory shape. */
export type ExtensionWidgetFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };
