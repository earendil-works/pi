import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ResolvedPaths } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ConfigSelectorComponent } from "../src/modes/interactive/components/config-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createSubagentResolvedPaths(baseDir: string): ResolvedPaths {
	return {
		extensions: [
			{
				path: join(baseDir, "extensions", "index.ts"),
				enabled: true,
				metadata: {
					source: "npm:pi-subagents",
					scope: "user",
					origin: "package",
					baseDir,
				},
			},
		],
		skills: [
			{
				path: join(baseDir, "agents", "scout.md"),
				enabled: true,
				metadata: {
					source: "npm:pi-subagents",
					scope: "user",
					origin: "package",
					baseDir,
				},
			},
		],
		prompts: [],
		themes: [],
	};
}

describe("ConfigSelectorComponent add-ons UX", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	test("renders package-first add-on details with subagent model guidance", () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-config-selector-"));
		const agentDir = join(tmp, "agent");
		const cwd = join(tmp, "project");
		const packageBase = join(tmp, "packages", "pi-subagents");
		const settingsManager = SettingsManager.create(cwd, agentDir);
		settingsManager.setPackages(["npm:pi-subagents"]);

		const component = new ConfigSelectorComponent(
			createSubagentResolvedPaths(packageBase),
			settingsManager,
			cwd,
			agentDir,
			() => {},
			() => {},
			() => {},
			24,
		);

		const output = stripAnsi(component.render(160).join("\n"));

		expect(output).toContain("pi-subagents");
		expect(output).toContain("2/2 abilities enabled");
		expect(output).toContain("Add-on details");
		expect(output).toContain("Model fit: subagents are model-sensitive");
		expect(output).toContain("Local models are usually fine for scout/search roles.");
	});

	test("toggles a whole add-on from the package row", () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-config-selector-"));
		const agentDir = join(tmp, "agent");
		const cwd = join(tmp, "project");
		const packageBase = join(tmp, "packages", "pi-subagents");
		const settingsManager = SettingsManager.create(cwd, agentDir);
		settingsManager.setPackages(["npm:pi-subagents"]);

		const component = new ConfigSelectorComponent(
			createSubagentResolvedPaths(packageBase),
			settingsManager,
			cwd,
			agentDir,
			() => {},
			() => {},
			() => {},
			24,
		);

		component.getResourceList().handleInput(" ");

		const packages = settingsManager.getPackages();
		const pkg = packages[0];
		if (typeof pkg === "string") {
			throw new Error("Expected package filters after toggling add-on");
		}

		expect(pkg.extensions).toContain("-extensions/index.ts");
		expect(pkg.skills).toContain("-agents/scout.md");
		expect(stripAnsi(component.render(160).join("\n"))).toContain("0/2 abilities enabled");
	});
});
