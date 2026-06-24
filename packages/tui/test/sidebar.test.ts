import { ok, strictEqual } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SidebarContainer, SidebarRegistry, Text } from "../src/index.ts";

describe("SidebarRegistry", () => {
	afterEach(() => SidebarRegistry.clear());

	it("register and getAll", () => {
		SidebarRegistry.register({ id: "a", label: "A", create: () => new Text("A", 0, 0) });
		SidebarRegistry.register({ id: "b", label: "B", create: () => new Text("B", 0, 0) });
		const all = SidebarRegistry.getAll();
		strictEqual(all.length, 2);
		ok(all.some((r) => r.id === "a"));
		ok(all.some((r) => r.id === "b"));
	});

	it("duplicate id overwrites", () => {
		SidebarRegistry.register({ id: "x", label: "Old", create: () => new Text("Old", 0, 0) });
		SidebarRegistry.register({ id: "x", label: "New", create: () => new Text("New", 0, 0) });
		const all = SidebarRegistry.getAll();
		strictEqual(all.length, 1);
		strictEqual(all[0]!.label, "New");
	});

	it("get returns specific registration", () => {
		SidebarRegistry.register({ id: "a", label: "A", create: () => new Text("A", 0, 0) });
		const reg = SidebarRegistry.get("a");
		ok(reg);
		strictEqual(reg!.id, "a");
		strictEqual(SidebarRegistry.get("nonexistent"), undefined);
	});

	it("clear empties registry", () => {
		SidebarRegistry.register({ id: "a", label: "A", create: () => new Text("A", 0, 0) });
		SidebarRegistry.clear();
		strictEqual(SidebarRegistry.getAll().length, 0);
	});
});

describe("SidebarContainer", () => {
	it("empty config renders nothing", () => {
		const container = new SidebarContainer(() => {});
		const lines = container.render(80);
		strictEqual(lines.length, 0);
	});

	it("single tab renders content directly (no tab bar)", () => {
		const container = new SidebarContainer(() => {});
		container.updateConfig([{ id: "a", label: "Panel A", component: new Text("Hello", 0, 0) }]);
		const lines = container.render(80);
		strictEqual(lines.length, 1);
		ok(lines[0]!.includes("Hello"));
	});

	it("multiple tabs renders tab bar", () => {
		const container = new SidebarContainer(() => {});
		container.updateConfig([
			{ id: "a", label: "A", component: new Text("Content A", 0, 0) },
			{ id: "b", label: "B", component: new Text("Content B", 0, 0) },
		]);
		const lines = container.render(80);
		ok(lines.length >= 2);
		ok(lines[0]!.includes("A"));
		ok(lines[0]!.includes("B"));
		ok(lines[0]!.includes("\u2502"));
		ok(lines[2]!.includes("Content A"));
	});

	it("switchTo changes active tab", () => {
		const container = new SidebarContainer(() => {});
		container.updateConfig([
			{ id: "a", label: "A", component: new Text("Content A", 0, 0) },
			{ id: "b", label: "B", component: new Text("Content B", 0, 0) },
		]);
		container.switchTo("b");
		const lines = container.render(80);
		ok(lines[2]!.includes("Content B"));
	});

	it("switchTo unknown id is no-op", () => {
		const container = new SidebarContainer(() => {});
		container.updateConfig([{ id: "a", label: "A", component: new Text("Content A", 0, 0) }]);
		container.switchTo("nonexistent");
		strictEqual(container.getActiveId(), "a");
	});

	it("updateConfig replaces all tabs", () => {
		const container = new SidebarContainer(() => {});
		container.updateConfig([{ id: "a", label: "A", component: new Text("Old", 0, 0) }]);
		container.updateConfig([{ id: "b", label: "B", component: new Text("New", 0, 0) }]);
		strictEqual(container.getActiveId(), "b");
		const lines = container.render(80);
		ok(lines[0]!.includes("New"));
	});

	it("requestRender callback is triggered on switch", () => {
		let called = false;
		const container = new SidebarContainer(() => {
			called = true;
		});
		container.updateConfig([
			{ id: "a", label: "A", component: new Text("A", 0, 0) },
			{ id: "b", label: "B", component: new Text("B", 0, 0) },
		]);
		called = false;
		container.switchTo("b");
		ok(called, "requestRender was called");
	});

	it("active tab highlighted in tab bar", () => {
		const container = new SidebarContainer(() => {});
		container.updateConfig([
			{ id: "a", label: "A", component: new Text("A", 0, 0) },
			{ id: "b", label: "B", component: new Text("B", 0, 0) },
		]);
		const lines = container.render(80);
		ok(lines[0]!.includes("\x1b[7m"));
	});
});
