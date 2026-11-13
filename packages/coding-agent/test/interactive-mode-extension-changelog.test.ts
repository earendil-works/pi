import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { Extension, MarkdownMessageType, MarkdownTransformer } from "../src/core/extensions/types.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { getSourcePackageKey, type SourceInfo } from "../src/core/source-info.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type ExtensionChangelogUpdate = { name: string; version: string; markdown: string };

type ExtensionChangelogContext = {
	session: {
		state: { messages: unknown[] };
		resourceLoader: { getExtensions(): { extensions: Array<{ sourceInfo: SourceInfo }> } };
	};
	settingsManager: SettingsManager;
	readPackageJson(packageRoot: string): { name?: string; version?: string } | undefined;
};

type StartupNoticesContext = {
	startupNoticesShown: boolean;
	changelogMarkdown: string | undefined;
	extensionChangelogUpdates: ExtensionChangelogUpdate[];
	version: string;
	chatContainer: Container;
	settingsManager: SettingsManager;
	mermaidMarkdownTransformer: MarkdownTransformer;
	session: { extensionRunner: { getMarkdownTransformers(): MarkdownTransformer[] } };
};

const prototype = InteractiveMode.prototype as unknown as {
	getExtensionChangelogUpdates(this: ExtensionChangelogContext): ExtensionChangelogUpdate[];
	readPackageJson(packageRoot: string): { name?: string; version?: string } | undefined;
	showStartupNoticesIfNeeded(this: StartupNoticesContext): void;
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

	function display(): ExtensionChangelogUpdate[] {
		return prototype.getExtensionChangelogUpdates.call(createContext());
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

		expect(display()).toEqual([]);
		expect(settingsManager.getExtensionChangelogVersion(getSourcePackageKey(sourceInfo))).toBe("1.0.0");
	});

	test("shows entries newer than the last seen version, headed by package name", () => {
		writePackage("1.0.0");
		display();
		writePackage("1.2.0");

		expect(display()).toEqual([
			{
				name: "pi-demo-extension",
				version: "1.2.0",
				markdown:
					"## pi-demo-extension [1.2.0]\n\n- Added feature B\n\n## pi-demo-extension [1.1.0]\n\n- Added feature A",
			},
		]);
		expect(settingsManager.getExtensionChangelogVersion(getSourcePackageKey(sourceInfo))).toBe("1.2.0");
		expect(display()).toEqual([]);
	});

	// #11703
	test("does not repeat entries for a prerelease version", () => {
		writePackage("1.0.0");
		display();
		writePackage("1.2.0-20261020.7");

		expect(display()).toHaveLength(1);
		expect(display()).toEqual([]);
	});

	test("shows nothing for an unreadable last seen version and records the current one", () => {
		const key = getSourcePackageKey(sourceInfo);
		settingsManager.setExtensionChangelogVersion(key, "latest");
		writePackage("1.0.0");

		expect(display()).toEqual([]);
		expect(settingsManager.getExtensionChangelogVersion(key)).toBe("1.0.0");

		writePackage("1.2.0");
		expect(display()).toHaveLength(1);
	});

	test("skips resumed sessions", () => {
		writePackage("1.0.0");
		display();
		writePackage("1.2.0");
		messages.push({ role: "user", content: "hi" });

		expect(display()).toEqual([]);
		expect(settingsManager.getExtensionChangelogVersion(getSourcePackageKey(sourceInfo))).toBe("1.0.0");
	});

	test("ignores non-package extensions and packages without a changelog", () => {
		writePackage("1.0.0");
		sourceInfo = { ...sourceInfo, origin: "top-level" };
		expect(display()).toEqual([]);

		sourceInfo = { ...sourceInfo, origin: "package", changelogPath: undefined };
		expect(display()).toEqual([]);
		expect(settingsManager.getExtensionChangelogVersion(getSourcePackageKey(sourceInfo))).toBeUndefined();
	});
});

describe("InteractiveMode startup notices", () => {
	beforeAll(() => initTheme("dark"));

	function extensionWithTransformer(
		transformer: MarkdownTransformer,
		messageTypes: readonly MarkdownMessageType[],
	): Pick<Extension, "markdownTransformer"> {
		return { markdownTransformer: { transformer, messageTypes: new Set(messageTypes) } };
	}

	function renderNotices(extensions: Pick<Extension, "markdownTransformer">[]): string {
		// getMarkdownTransformers only reads the extensions' transformer registrations.
		const runner = { extensions } as unknown as ExtensionRunner;
		const context: StartupNoticesContext = {
			startupNoticesShown: false,
			changelogMarkdown: "## [2.0.0]\n\n- :warning: Pi change",
			extensionChangelogUpdates: [
				{
					name: "pi-demo",
					version: "1.2.0",
					markdown: "## pi-demo [1.2.0]\n\n- :warning: Demo change",
				},
			],
			version: "2.0.0",
			chatContainer: new Container(),
			settingsManager: SettingsManager.fromStorage(new InMemorySettingsStorage()),
			mermaidMarkdownTransformer: (markdown) => markdown,
			session: {
				extensionRunner: {
					getMarkdownTransformers: () => ExtensionRunner.prototype.getMarkdownTransformers.call(runner),
				},
			},
		};
		Object.setPrototypeOf(context, InteractiveMode.prototype);
		prototype.showStartupNoticesIfNeeded.call(context);
		return stripAnsi(context.chatContainer.render(120).join("\n"));
	}

	const replaceShortcodes: MarkdownTransformer = (markdown) => markdown.replaceAll(":warning:", "⚠");

	test("runs changelog transformers on What's New and Extension Updates", () => {
		const rendered = renderNotices([extensionWithTransformer(replaceShortcodes, ["changelog"])]);

		expect(rendered).toContain("⚠ Pi change");
		expect(rendered).toContain("⚠ Demo change");
		expect(rendered).not.toContain(":warning:");
	});

	test("skips transformers registered for the default message types", () => {
		const rendered = renderNotices([
			extensionWithTransformer(replaceShortcodes, ["user", "assistant", "assistant-thinking"]),
		]);

		expect(rendered).toContain(":warning: Pi change");
		expect(rendered).toContain(":warning: Demo change");
	});
});
