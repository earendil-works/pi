import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { getLoadoutResourceReferenceKey, type LoadoutSnapshot } from "../src/core/loadout.ts";
import {
	buildSessionLoadoutOverrides,
	SessionLoadoutSelectorComponent,
} from "../src/modes/interactive/components/session-loadout-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const extensionReference = {
	type: "extension" as const,
	origin: "top-level" as const,
	scope: "user" as const,
	relativePath: "extensions/example.ts",
};

const missingPromptReference = {
	type: "prompt" as const,
	origin: "top-level" as const,
	scope: "user" as const,
	relativePath: "prompts/missing.md",
};

function createSnapshot(): LoadoutSnapshot {
	return {
		resources: [
			{
				reference: extensionReference,
				path: "/agent/extensions/example.ts",
				enabled: true,
				defaultEnabled: true,
				metadata: {
					source: "auto",
					scope: "user",
					origin: "top-level",
					baseDir: "/agent/extensions",
				},
			},
		],
		overrides: [{ reference: missingPromptReference, enabled: true }],
		diagnostics: [],
	};
}

describe("SessionLoadoutSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("stages toggles until Enter and identifies session-only behavior", () => {
		const onApply = vi.fn();
		const selector = new SessionLoadoutSelectorComponent({
			snapshot: createSnapshot(),
			agentDir: "/agent",
			onApply,
			onCancel: () => {},
			requestRender: () => {},
		});
		const list = selector.getResourceList();

		const rendered = stripAnsi(selector.render(100).join("\n"));
		expect(rendered).toContain("Session Loadout");
		expect(rendered).toContain("staged until apply");
		expect(rendered).toContain("global/project settings unchanged");
		expect(rendered).toContain("example.ts");

		list.handleInput!("\u001b[B");
		list.handleInput!(" ");
		expect(onApply).not.toHaveBeenCalled();
		list.handleInput!("\n");

		expect(onApply).toHaveBeenCalledOnce();
		expect(onApply.mock.calls[0]?.[0]).toEqual({
			overrides: [
				{ reference: missingPromptReference, enabled: true },
				{ reference: extensionReference, enabled: false },
			],
			explicitReset: false,
		});
	});

	it("discards with Escape and emits no staged changes", () => {
		const onApply = vi.fn();
		const onCancel = vi.fn();
		const selector = new SessionLoadoutSelectorComponent({
			snapshot: createSnapshot(),
			agentDir: "/agent",
			onApply,
			onCancel,
			requestRender: () => {},
		});
		const list = selector.getResourceList();

		list.handleInput!("\u001b[B");
		list.handleInput!(" ");
		list.handleInput!("\u001b");

		expect(onCancel).toHaveBeenCalledOnce();
		expect(onApply).not.toHaveBeenCalled();
	});

	it("clears visible and unmatched overrides through the reset row", () => {
		const snapshot = createSnapshot();
		snapshot.resources[0]!.enabled = false;
		snapshot.overrides.push({ reference: extensionReference, enabled: false });
		const onApply = vi.fn();
		const selector = new SessionLoadoutSelectorComponent({
			snapshot,
			agentDir: "/agent",
			onApply,
			onCancel: () => {},
			requestRender: () => {},
		});
		const list = selector.getResourceList();

		list.handleInput!(" ");
		list.handleInput!("\n");

		expect(onApply).toHaveBeenCalledWith({ overrides: [], explicitReset: true });
		expect(stripAnsi(selector.render(100).join("\n"))).toContain("[x] Use persistent settings");
	});

	it("keeps unavailable overrides cleared when adjusting a resource after reset", () => {
		const snapshot = createSnapshot();
		snapshot.resources[0]!.enabled = false;
		snapshot.overrides.push({ reference: extensionReference, enabled: false });
		const onApply = vi.fn();
		const selector = new SessionLoadoutSelectorComponent({
			snapshot,
			agentDir: "/agent",
			onApply,
			onCancel: () => {},
			requestRender: () => {},
		});
		const list = selector.getResourceList();

		list.handleInput!(" ");
		list.handleInput!("\u001b[B");
		list.handleInput!(" ");
		list.handleInput!("\n");

		expect(onApply).toHaveBeenCalledWith({
			overrides: [{ reference: extensionReference, enabled: false }],
			explicitReset: true,
		});
	});

	it("distinguishes applying an unchanged empty loadout from an explicit reset", () => {
		const snapshot = createSnapshot();
		snapshot.overrides = [];
		const onApply = vi.fn();
		const selector = new SessionLoadoutSelectorComponent({
			snapshot,
			agentDir: "/agent",
			onApply,
			onCancel: () => {},
			requestRender: () => {},
		});

		selector.getResourceList().handleInput!("\n");

		expect(onApply).toHaveBeenCalledWith({ overrides: [], explicitReset: false });
	});
});

describe("buildSessionLoadoutOverrides", () => {
	it("drops visible states matching defaults while retaining unavailable references", () => {
		const snapshot = createSnapshot();
		const enabled = new Map([[getLoadoutResourceReferenceKey(extensionReference), true]]);

		expect(buildSessionLoadoutOverrides(snapshot, enabled, false)).toEqual([
			{ reference: missingPromptReference, enabled: true },
		]);
	});
});
