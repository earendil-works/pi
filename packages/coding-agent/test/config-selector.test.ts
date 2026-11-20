import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ResolvedPaths } from "../src/core/package-manager.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { ConfigSelectorComponent } from "../src/modes/interactive/components/config-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("config selector search", () => {
	let tempDir: string;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		tempDir = mkdtempSync(join(tmpdir(), "pi-config-selector-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("keeps the selection when a cursor key leaves the query unchanged", () => {
		const packageRoot = join(tempDir, "pkg");
		const resolvedPaths: ResolvedPaths = {
			extensions: ["tool-a.ts", "tool-b.ts", "other.ts"].map((name) => ({
				path: join(packageRoot, "extensions", name),
				enabled: true,
				metadata: { source: "npm:pi-tools", scope: "user", origin: "package", baseDir: packageRoot },
			})),
			skills: [],
			prompts: [],
			themes: [],
		};
		const selector = new ConfigSelectorComponent(
			{ global: resolvedPaths, project: resolvedPaths },
			SettingsManager.fromStorage(new InMemorySettingsStorage(), { projectTrusted: true }),
			tempDir,
			join(tempDir, "agent"),
			() => {},
			() => {},
			() => {},
		);
		const list = selector.getResourceList();
		const selectedRow = () =>
			stripAnsi(list.render(120).join("\n"))
				.split("\n")
				.find((line) => line.startsWith(">") && line.includes(".ts"));

		for (const char of "tool") list.handleInput(char);
		list.handleInput("\x1b[B");
		expect(selectedRow()).toContain("tool-b");
		list.handleInput("\x1b[D"); // Left
		list.handleInput("\x1b[H"); // Home

		expect(selectedRow()).toContain("tool-b");
	});
});
