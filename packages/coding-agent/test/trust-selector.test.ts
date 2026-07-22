import { resolve } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { TrustSelectorComponent } from "../src/modes/interactive/components/trust-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("TrustSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("marks the saved trusted decision", () => {
		const projectPath = resolve("/project");
		const selector = new TrustSelectorComponent({
			cwd: projectPath,
			savedDecision: { path: projectPath, decision: true },
			projectTrusted: true,
			onSelect: () => {},
			onCancel: () => {},
		});

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain(`Saved decision: trusted (${projectPath})`);
		expect(output).toContain("Current session: trusted");
		expect(output).toContain("Trust ✓");
		expect(output).not.toContain("Do not trust ✓");
	});

	it("selects a trust decision", () => {
		const projectPath = resolve("/project");
		const onSelect = vi.fn();
		const selector = new TrustSelectorComponent({
			cwd: projectPath,
			savedDecision: null,
			projectTrusted: false,
			onSelect,
			onCancel: () => {},
		});

		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith({ trusted: true, updates: [{ path: projectPath, decision: true }] });
	});

	it("labels saved ancestor decisions as inherited", () => {
		const parentPath = resolve("/parent");
		const selector = new TrustSelectorComponent({
			cwd: resolve("/parent/project/nested"),
			savedDecision: { path: parentPath, decision: true },
			projectTrusted: true,
			onSelect: () => {},
			onCancel: () => {},
		});

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain(`Saved decision: trusted (inherited from ${parentPath})`);
	});

	it("adds a trust parent option", () => {
		const parentPath = resolve("/parent");
		const projectPath = resolve("/parent/project");
		const onSelect = vi.fn();
		const selector = new TrustSelectorComponent({
			cwd: projectPath,
			savedDecision: { path: parentPath, decision: true },
			projectTrusted: true,
			onSelect,
			onCancel: () => {},
		});

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain(`Saved decision: trusted (inherited from ${parentPath})`);
		expect(output).toContain(`Trust parent folder (${parentPath}) ${String.fromCharCode(0x2713)}`);

		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith({
			trusted: true,
			updates: [
				{ path: parentPath, decision: true },
				{ path: projectPath, decision: null },
			],
		});
	});
});
