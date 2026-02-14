import assert from "node:assert";
import { describe, it } from "node:test";
import { RenderCacheContainer, type RevisionedComponent } from "../src/render-cache-container.js";
import type { Component } from "../src/tui.js";

class CountingRevisioned implements RevisionedComponent {
	public renders = 0;
	private revision = 0;

	getRevision(): number {
		return this.revision;
	}

	bump(): void {
		this.revision++;
	}

	invalidate(): void {
		// Simulate a theme change or other external invalidation.
		this.revision++;
	}

	render(width: number): string[] {
		this.renders++;
		return ["rev".padEnd(width, " ")];
	}
}

class CountingPlain implements Component {
	public renders = 0;

	invalidate(): void {}

	render(width: number): string[] {
		this.renders++;
		return ["plain".padEnd(width, " ")];
	}
}

describe("RenderCacheContainer", () => {
	it("reuses cached lines when revision and width are unchanged", () => {
		const c = new RenderCacheContainer();
		const child = new CountingRevisioned();
		c.addChild(child);

		c.render(10);
		c.render(10);

		assert.equal(child.renders, 1);
	});

	it("re-renders when revision changes", () => {
		const c = new RenderCacheContainer();
		const child = new CountingRevisioned();
		c.addChild(child);

		c.render(10);
		child.bump();
		c.render(10);

		assert.equal(child.renders, 2);
	});

	it("re-renders when width changes", () => {
		const c = new RenderCacheContainer();
		const child = new CountingRevisioned();
		c.addChild(child);

		c.render(10);
		c.render(20);

		assert.equal(child.renders, 2);
	});

	it("does not cache non-revisioned children", () => {
		const c = new RenderCacheContainer();
		const child = new CountingPlain();
		c.addChild(child);

		c.render(10);
		c.render(10);

		assert.equal(child.renders, 2);
	});

	it("invalidate clears caches and triggers re-render", () => {
		const c = new RenderCacheContainer();
		const child = new CountingRevisioned();
		c.addChild(child);

		c.render(10);
		c.invalidate();
		c.render(10);

		assert.equal(child.renders, 2);
	});
});
