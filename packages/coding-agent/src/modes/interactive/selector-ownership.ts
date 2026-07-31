import type { Component } from "@earendil-works/pi-tui";

export interface SelectorView {
	component: Component;
	focus: Component;
	dispose?: () => void;
}

type SelectorEntry = {
	dispose?: () => void;
	disposed: boolean;
};

/**
 * Owns the single interactive editor-slot selector.
 *
 * - Replacement and close dispose the previous entry once.
 * - A stale `done` cannot close a newer selector.
 * - Factories that complete synchronously before mount never become current.
 */
export class SelectorOwnership {
	private current: SelectorEntry | undefined;
	private readonly mount: (component: Component, focus: Component) => void;
	private readonly restore: () => void;

	constructor(mount: (component: Component, focus: Component) => void, restore: () => void) {
		this.mount = mount;
		this.restore = restore;
	}

	show(create: (done: () => void) => SelectorView): boolean {
		const entry: SelectorEntry = { disposed: false };
		let creating = true;
		let canceled = false;
		const done = () => {
			if (creating) {
				canceled = true;
				return;
			}
			this.close(entry);
		};

		const view = create(done);
		creating = false;
		entry.dispose = view.dispose;

		if (canceled) {
			this.dispose(entry);
			return false;
		}

		const previous = this.current;
		this.current = undefined;
		if (previous) this.dispose(previous);

		this.current = entry;
		this.mount(view.component, view.focus);
		return true;
	}

	private close(entry: SelectorEntry): void {
		if (this.current !== entry) return;
		this.current = undefined;
		this.dispose(entry);
		this.restore();
	}

	private dispose(entry: SelectorEntry): void {
		if (entry.disposed) return;
		entry.disposed = true;
		const dispose = entry.dispose;
		entry.dispose = undefined;
		dispose?.();
	}
}
