import { type Component, Container } from "./tui.js";

/**
 * Optional component contract for incremental rendering.
 *
 * If a component exposes a revision number, containers can safely cache its
 * rendered output across frames.
 *
 * Invariant: For a fixed `width` and `revision`, `render(width)` must be pure
 * (deterministic) and return the same lines.
 */
export interface RevisionedComponent extends Component {
	getRevision(): number;
}

function isRevisionedComponent(component: Component): component is RevisionedComponent {
	return "getRevision" in component && typeof (component as { getRevision?: unknown }).getRevision === "function";
}

interface ChildCacheEntry {
	width: number;
	revision: number;
	lines: string[];
}

/**
 * Container that caches each child's rendered `string[]` by `(width, revision)`.
 *
 * This is intended for large, mostly-static trees (chat history) where only a
 * small subset of children change each frame (streaming message, loader, editor).
 */
export class RenderCacheContainer extends Container {
	private childCache = new Map<Component, ChildCacheEntry>();

	override addChild(component: Component): void {
		super.addChild(component);
		// Don't prepopulate cache; render() will fill it.
	}

	override removeChild(component: Component): void {
		super.removeChild(component);
		this.childCache.delete(component);
	}

	override clear(): void {
		super.clear();
		this.childCache.clear();
	}

	override invalidate(): void {
		// Theme changes or global invalidations must drop caches.
		this.childCache.clear();
		super.invalidate();
	}

	override render(width: number): string[] {
		const lines: string[] = [];

		for (const child of this.children) {
			if (!isRevisionedComponent(child)) {
				// No revision contract: treat as always-dirty.
				lines.push(...child.render(width));
				continue;
			}

			const revision = child.getRevision();
			const cached = this.childCache.get(child);
			if (cached && cached.width === width && cached.revision === revision) {
				lines.push(...cached.lines);
				continue;
			}

			const childLines = child.render(width);
			this.childCache.set(child, { width, revision, lines: childLines });
			lines.push(...childLines);
		}

		return lines;
	}
}
