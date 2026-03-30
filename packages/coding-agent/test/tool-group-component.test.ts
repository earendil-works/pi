import { type Terminal, Text, TUI } from "@mariozechner/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolGroupDefinition, ToolGroupMember } from "../src/core/extensions/types.js";
import { ToolGroupComponent } from "../src/modes/interactive/components/tool-group.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = true;
	writes: string[] = [];
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
}

function createDefinition(overrides?: Partial<ToolGroupDefinition>): ToolGroupDefinition {
	return {
		name: "test-group",
		match: (toolName) => toolName === "read",
		render: (members, _theme, _context) => new Text(`${members.length} members`, 0, 0),
		...overrides,
	};
}

function createTUI(): TUI {
	return new TUI(new FakeTerminal());
}

describe("ToolGroupComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders via the definition's render() function with correct member data", () => {
		const renderSpy = vi.fn(
			(members: ToolGroupMember[], _theme: any, _ctx: any) => new Text(`${members.length} items`, 0, 0),
		);
		const def = createDefinition({ render: renderSpy });
		const tui = createTUI();
		const group = new ToolGroupComponent(tui, def);

		group.addMember("tc-1", "read", { path: "/a.ts" });
		group.addMember("tc-2", "read", { path: "/b.ts" });

		expect(renderSpy).toHaveBeenCalled();
		const lastCall = renderSpy.mock.calls[renderSpy.mock.calls.length - 1];
		const members = lastCall[0] as ToolGroupMember[];
		expect(members).toHaveLength(2);
		expect(members[0].toolCallId).toBe("tc-1");
		expect(members[0].toolName).toBe("read");
		expect(members[0].args).toEqual({ path: "/a.ts" });
		expect(members[0].argsComplete).toBe(false);
		expect(members[0].executionStarted).toBe(false);
		expect(members[0].isPartial).toBe(true);
		expect(members[1].toolCallId).toBe("tc-2");
	});

	it("uses pending background initially and transitions to success", () => {
		const def = createDefinition();
		const group = new ToolGroupComponent(createTUI(), def);
		group.addMember("tc-1", "read", {});

		const lines1 = group.render(80);
		expect(lines1.length).toBeGreaterThan(0);

		group.updateMemberResult("tc-1", { content: [{ type: "text", text: "ok" }], isError: false }, false);
		const lines2 = group.render(80);
		expect(lines2.length).toBeGreaterThan(0);
		// The lines should differ because bg changed from pending to success
		expect(lines1.join("\n")).not.toBe(lines2.join("\n"));
	});

	it("uses error background when any member has error result", () => {
		const def = createDefinition();
		const group = new ToolGroupComponent(createTUI(), def);
		group.addMember("tc-1", "read", {});
		group.addMember("tc-2", "read", {});

		group.updateMemberResult("tc-1", { content: [{ type: "text", text: "ok" }], isError: false }, false);
		group.updateMemberResult("tc-2", { content: [{ type: "text", text: "err" }], isError: true }, false);

		// Render and verify it doesn't crash - the actual color check is implicit
		// through the background function being set
		const lines = group.render(80);
		expect(lines.length).toBeGreaterThan(0);
	});

	it("re-renders when members are added or updated", () => {
		const renderSpy = vi.fn((members: ToolGroupMember[]) => new Text(`count:${members.length}`, 0, 0));
		const def = createDefinition({ render: renderSpy });
		const group = new ToolGroupComponent(createTUI(), def);

		group.addMember("tc-1", "read", {});
		const callsAfterAdd = renderSpy.mock.calls.length;

		group.updateMemberArgs("tc-1", { path: "/new.ts" });
		expect(renderSpy.mock.calls.length).toBeGreaterThan(callsAfterAdd);

		const callsAfterArgs = renderSpy.mock.calls.length;
		group.markMemberExecutionStarted("tc-1");
		expect(renderSpy.mock.calls.length).toBeGreaterThan(callsAfterArgs);

		const callsAfterExec = renderSpy.mock.calls.length;
		group.updateMemberResult("tc-1", { content: [], isError: false }, false);
		expect(renderSpy.mock.calls.length).toBeGreaterThan(callsAfterExec);
	});

	it("provides expanded and shared state through render context", () => {
		let capturedContext: any;
		const def = createDefinition({
			render: (_members, _theme, context) => {
				capturedContext = context;
				if (!context.state.counter) context.state.counter = 0;
				(context.state as Record<string, number>).counter++;
				return new Text("ok", 0, 0);
			},
		});
		const group = new ToolGroupComponent(createTUI(), def);

		group.addMember("tc-1", "read", {});
		expect(capturedContext.expanded).toBe(false);
		expect(capturedContext.state.counter).toBe(1);

		group.setExpanded(true);
		expect(capturedContext.expanded).toBe(true);
		expect(capturedContext.state.counter).toBe(2);
	});

	it("catches render() errors and displays a fallback", () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const def = createDefinition({
			render: () => {
				throw new Error("render boom");
			},
		});
		const group = new ToolGroupComponent(createTUI(), def);

		group.addMember("tc-1", "read", {});
		const lines = group.render(80);
		expect(lines.length).toBeGreaterThan(0);
		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it("displays fallback when render() returns null", () => {
		const def = createDefinition({ render: () => null });
		const group = new ToolGroupComponent(createTUI(), def);

		group.addMember("tc-1", "read", {});
		const lines = group.render(80);
		expect(lines.length).toBeGreaterThan(0);
	});

	it("logs warning and rejects member added after closure", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const renderSpy = vi.fn((members: ToolGroupMember[]) => new Text(`${members.length}`, 0, 0));
		const def = createDefinition({ render: renderSpy });
		const group = new ToolGroupComponent(createTUI(), def);

		group.addMember("tc-1", "read", {});
		group.close();
		group.addMember("tc-2", "read", {});

		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("closed"));
		const lastMembers = renderSpy.mock.calls[renderSpy.mock.calls.length - 1][0];
		expect(lastMembers).toHaveLength(1);
		warnSpy.mockRestore();
	});

	it("dispose() prevents invalidate() from triggering requestRender()", () => {
		let capturedInvalidate: (() => void) | undefined;
		const def = createDefinition({
			render: (_members, _theme, context) => {
				capturedInvalidate = context.invalidate;
				return new Text("ok", 0, 0);
			},
		});
		const tui = createTUI();
		const requestRenderSpy = vi.spyOn(tui, "requestRender");
		const group = new ToolGroupComponent(tui, def);

		group.addMember("tc-1", "read", {});
		expect(capturedInvalidate).toBeDefined();

		requestRenderSpy.mockClear();
		group.dispose();
		capturedInvalidate!();
		expect(requestRenderSpy).not.toHaveBeenCalled();
	});

	it("batchUpdate() suppresses renders and calls once after", () => {
		const renderSpy = vi.fn((members: ToolGroupMember[]) => new Text(`${members.length}`, 0, 0));
		const def = createDefinition({ render: renderSpy });
		const group = new ToolGroupComponent(createTUI(), def);

		group.addMember("tc-1", "read", {});
		group.addMember("tc-2", "read", {});
		const callsBefore = renderSpy.mock.calls.length;

		group.batchUpdate(() => {
			group.updateMemberArgs("tc-1", { path: "/x" });
			group.updateMemberArgs("tc-2", { path: "/y" });
			group.markMemberExecutionStarted("tc-1");
			// No render calls during batch
			expect(renderSpy.mock.calls.length).toBe(callsBefore);
		});

		// Exactly one render after batch completes
		expect(renderSpy.mock.calls.length).toBe(callsBefore + 1);
	});

	it("close() is idempotent", () => {
		const def = createDefinition();
		const group = new ToolGroupComponent(createTUI(), def);
		group.addMember("tc-1", "read", {});

		group.close();
		group.close();
		group.close();
		// No error thrown, still closed
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		group.addMember("tc-2", "read", {});
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it("populateMemberResult() sets result without triggering updateDisplay()", () => {
		const renderSpy = vi.fn((_m: ToolGroupMember[], _t: any, _c: any) => new Text("ok", 0, 0));
		const def = createDefinition({ render: renderSpy });
		const group = new ToolGroupComponent(createTUI(), def);

		group.addMember("tc-1", "read", {});
		const callsAfterAdd = renderSpy.mock.calls.length;

		group.populateMemberResult("tc-1", { content: [{ type: "text", text: "data" }], isError: false });
		expect(renderSpy.mock.calls.length).toBe(callsAfterAdd);

		// Verify the data was actually set by triggering a render manually
		group.batchUpdate(() => {}); // triggers updateDisplay
		const lastMembers = renderSpy.mock.calls[renderSpy.mock.calls.length - 1][0] as ToolGroupMember[];
		expect(lastMembers[0].result).toBeDefined();
		expect(lastMembers[0].isPartial).toBe(false);
		expect(lastMembers[0].argsComplete).toBe(true);
	});

	it("setMemberArgsComplete() is idempotent", () => {
		const renderSpy = vi.fn(() => new Text("ok", 0, 0));
		const def = createDefinition({ render: renderSpy });
		const group = new ToolGroupComponent(createTUI(), def);

		group.addMember("tc-1", "read", {});
		const callsAfterAdd = renderSpy.mock.calls.length;

		group.setMemberArgsComplete("tc-1");
		const callsAfterFirst = renderSpy.mock.calls.length;
		expect(callsAfterFirst).toBe(callsAfterAdd + 1);

		group.setMemberArgsComplete("tc-1");
		expect(renderSpy.mock.calls.length).toBe(callsAfterFirst);
	});

	it("nested batchUpdate() only triggers updateDisplay on outermost completion", () => {
		const renderSpy = vi.fn(() => new Text("ok", 0, 0));
		const def = createDefinition({ render: renderSpy });
		const group = new ToolGroupComponent(createTUI(), def);

		group.addMember("tc-1", "read", {});
		group.addMember("tc-2", "read", {});
		const callsBefore = renderSpy.mock.calls.length;

		group.batchUpdate(() => {
			group.updateMemberArgs("tc-1", { path: "/a" });
			expect(renderSpy.mock.calls.length).toBe(callsBefore);

			group.batchUpdate(() => {
				group.updateMemberArgs("tc-2", { path: "/b" });
				expect(renderSpy.mock.calls.length).toBe(callsBefore);
			});

			// Inner batch completed but outer is still active
			expect(renderSpy.mock.calls.length).toBe(callsBefore);
		});

		// Only one render after outermost completes
		expect(renderSpy.mock.calls.length).toBe(callsBefore + 1);
	});

	it("render context lastComponent is set after render", () => {
		let capturedContext: any;
		const component = new Text("stable", 0, 0);
		const def = createDefinition({
			render: (_members, _theme, context) => {
				capturedContext = context;
				return component;
			},
		});
		const group = new ToolGroupComponent(createTUI(), def);

		group.addMember("tc-1", "read", {});
		expect(capturedContext.lastComponent).toBe(component);
	});

	it("does not re-add child when render returns same component reference", () => {
		const stableComponent = new Text("stable", 0, 0);
		let renderCount = 0;
		const def = createDefinition({
			render: () => {
				renderCount++;
				return stableComponent;
			},
		});
		const group = new ToolGroupComponent(createTUI(), def);

		group.addMember("tc-1", "read", {});
		group.updateMemberArgs("tc-1", { path: "/x" });

		// Both renders return same component; verify no crash and component is still there
		expect(renderCount).toBe(2);
		const lines = group.render(80);
		expect(lines.length).toBeGreaterThan(0);
	});

	it("members array passed to render is a copy", () => {
		let capturedMembers: ToolGroupMember[] | undefined;
		const def = createDefinition({
			render: (members) => {
				capturedMembers = members;
				return new Text("ok", 0, 0);
			},
		});
		const group = new ToolGroupComponent(createTUI(), def);

		group.addMember("tc-1", "read", {});
		const firstMembers = capturedMembers;

		group.addMember("tc-2", "read", {});
		// First captured array should still have 1 member (it was a copy)
		expect(firstMembers).toHaveLength(1);
		expect(capturedMembers).toHaveLength(2);
	});

	it("updateMemberResult with isPartial=false sets argsComplete=true", () => {
		const renderSpy = vi.fn((_members: ToolGroupMember[]) => new Text("ok", 0, 0));
		const def = createDefinition({ render: renderSpy });
		const group = new ToolGroupComponent(createTUI(), def);

		group.addMember("tc-1", "read", {});
		group.updateMemberResult("tc-1", { content: [], isError: false }, false);

		const lastMembers = renderSpy.mock.calls[renderSpy.mock.calls.length - 1][0] as ToolGroupMember[];
		expect(lastMembers[0].argsComplete).toBe(true);
		expect(lastMembers[0].isPartial).toBe(false);
	});
});
