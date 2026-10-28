import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { getSourcePackageKey, type SourceInfo } from "../src/core/source-info.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type ExtensionChangelogContext = {
	session: {
		state: { messages: unknown[] };
		resourceLoader: { getExtensions(): { extensions: Array<{ sourceInfo: SourceInfo }> } };
	};
	settingsManager: SettingsManager;
	readPackageJson(packageRoot: string): { name?: string; version?: string } | undefined;
};

const prototype = InteractiveMode.prototype as unknown as {
	getExtensionChangelogForDisplay(this: ExtensionChangelogContext): string | undefined;
	readPackageJson(packageRoot: string): { name?: string; version?: string } | undefined;
};

const CHANGELOG = `# Changelog

## [Unreleased]

- Not released yet

## [1.2.0]

- Added feature B

## [1.1.0]

- Added feature A

## [1.0.0]

- Initial release
`;

describe("InteractiveMode extension changelog", () => {
	let tempDir: string;
	let packageRoot: string;
	let sourceInfo: SourceInfo;
	let settingsManager: SettingsManager;
	let messages: unknown[];

	function writePackage(version: string): void {
		writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-demo-extension", version }));
	}

	function createContext(): ExtensionChangelogContext {
		return {
			session: {
				state: { messages },
				resourceLoader: {
					getExtensions: () => ({
						// Two extensions from the same package must only produce one changelog section.
						extensions: [{ sourceInfo }, { sourceInfo: { ...sourceInfo, path: join(packageRoot, "b.ts") } }],
					}),
				},
			},
			settingsManager,
			readPackageJson: prototype.readPackageJson,
		};
	}

	function display(): string | undefined {
		return prototype.getExtensionChangelogForDisplay.call(createContext());
	}

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-extension-changelog-"));
		packageRoot = join(tempDir, "pkg");
		mkdirSync(packageRoot);
		writeFileSync(join(packageRoot, "CHANGELOG.md"), CHANGELOG);
		sourceInfo = {
			path: join(packageRoot, "a.ts"),
			source: "npm:pi-demo-extension",
			scope: "user",
			origin: "package",
			baseDir: packageRoot,
			changelogPath: join(packageRoot, "CHANGELOG.md"),
		};
		settingsManager = SettingsManager.fromStorage(new InMemorySettingsStorage());
		messages = [];
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("records the version on first launch without showing the changelog", () => {
		writePackage("1.0.0");

		expect(display()).toBeUndefined();
		expect(settingsManager.getExtensionChangelogVersion(getSourcePackageKey(sourceInfo))).toBe("1.0.0");
	});

	test("shows entries newer than the last seen version, headed by package name", () => {
		writePackage("1.0.0");
		display();
		writePackage("1.2.0");

		const markdown = display();

		expect(markdown).toBe(
			"## pi-demo-extension [1.2.0]\n\n- Added feature B\n\n## pi-demo-extension [1.1.0]\n\n- Added feature A",
		);
		expect(settingsManager.getExtensionChangelogVersion(getSourcePackageKey(sourceInfo))).toBe("1.2.0");
		expect(display()).toBeUndefined();
	});

	test("skips resumed sessions", () => {
		writePackage("1.0.0");
		display();
		writePackage("1.2.0");
		messages.push({ role: "user", content: "hi" });

		expect(display()).toBeUndefined();
		expect(settingsManager.getExtensionChangelogVersion(getSourcePackageKey(sourceInfo))).toBe("1.0.0");
	});

	test("ignores non-package extensions and packages without a changelog", () => {
		writePackage("1.0.0");
		sourceInfo = { ...sourceInfo, origin: "top-level" };
		expect(display()).toBeUndefined();

		sourceInfo = { ...sourceInfo, origin: "package", changelogPath: undefined };
		expect(display()).toBeUndefined();
		expect(settingsManager.getExtensionChangelogVersion(getSourcePackageKey(sourceInfo))).toBeUndefined();
	});
});
