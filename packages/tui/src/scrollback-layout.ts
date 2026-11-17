// Keep mutable content in the main-screen viewport, then archive it in order when complete.
import { type Component, Container } from "./tui.ts";

interface ArchiveSnapshot {
	revision: number;
	lines: readonly string[];
}

type Segment = { type: "history" } | { type: "component"; lines: readonly string[] };

export class ScrollbackLayout {
	private width = 0;
	private height = 0;
	private workingHeight = 0;
	private archives = new WeakMap<Component, ArchiveSnapshot>();

	invalidate(): void {
		this.archives = new WeakMap();
	}

	render(root: Container, width: number, height: number): readonly string[] {
		let historyContainer: Container | undefined;
		for (const child of root.children) {
			historyContainer = findHistoryContainer(child);
			if (historyContainer) break;
		}
		if (!historyContainer) return root.render(width);
		if (this.width !== width || this.height !== height) {
			this.width = width;
			this.height = height;
			this.workingHeight = 0;
			this.invalidate();
		}

		const items = historyContainer.children.map((component) => {
			const previous = component.getScrollbackState?.();
			const archived = this.archives.get(component);
			if (archived && previous && !previous.mutable && archived.revision === previous.revision) {
				return { component, lines: archived.lines, state: previous };
			}
			const lines = [...component.render(width)];
			// The first render may start deferred work; inspect archive readiness afterward.
			return { component, lines, state: component.getScrollbackState?.() };
		});
		const segments: Segment[] = [];
		const collect = (component: Component): void => {
			if (component === historyContainer) segments.push({ type: "history" });
			else if (component instanceof Container && component.constructor === Container) {
				for (const child of component.children) collect(child);
			} else segments.push({ type: "component", lines: component.render(width) });
		};
		for (const child of root.children) collect(child);
		const historyIndex = segments.findIndex((segment) => segment.type === "history");
		const prefix = segments
			.slice(0, historyIndex)
			.flatMap((segment) => (segment.type === "component" ? segment.lines : []));
		const suffix = segments
			.slice(historyIndex + 1)
			.flatMap((segment) => (segment.type === "component" ? segment.lines : []));
		const firstMutable = items.findIndex((item) => item.state?.mutable);
		const split = firstMutable < 0 ? items.length : firstMutable;
		for (let index = 0; index < items.length; index++) {
			const item = items[index];
			item.component.setScrollbackArchived?.(index < split);
			if (index < split && item.state && this.archives.get(item.component)?.lines !== item.lines) {
				this.archives.set(item.component, { revision: item.state.revision, lines: item.lines });
			}
		}
		const history = [...prefix, ...items.slice(0, split).flatMap((item) => item.lines)];
		const active = items.slice(split);
		const budget = Math.max(0, height - suffix.length);
		const preview: string[] = [];
		let remaining = budget;
		for (let index = 0; index < active.length && remaining > 0; index++) {
			const allocation = Math.ceil(remaining / (active.length - index));
			preview.push(...active[index].lines.slice(-allocation));
			remaining -= allocation;
		}
		const required = history.length + preview.length + suffix.length;
		if (this.workingHeight - history.length - suffix.length > budget) this.workingHeight = required;
		// Preserve the workspace when a short result replaces a long preview to avoid clearing scrollback.
		this.workingHeight = Math.max(this.workingHeight, required);
		const padding = Array<string>(this.workingHeight - required).fill("");
		return [...history, ...preview, ...padding, ...suffix];
	}
}

function findHistoryContainer(component: Component): Container | undefined {
	if (component.getScrollbackState || !(component instanceof Container) || component.constructor !== Container) {
		return undefined;
	}
	if (component.children.some((child) => child.getScrollbackState)) return component;
	for (const child of component.children) {
		const history = findHistoryContainer(child);
		if (history) return history;
	}
	return undefined;
}
