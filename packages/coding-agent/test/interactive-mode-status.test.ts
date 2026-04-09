import { Container } from "@mariozechner/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function renderLastLine(container: Container, width = 120): string {
	const last = container.children[container.children.length - 1];
	if (!last) return "";
	return last.render(width).join("\n");
}

function renderAll(container: Container, width = 120): string {
	return container.children.flatMap((child) => child.render(width)).join("\n");
}

describe("InteractiveMode.showStatus", () => {
	beforeAll(() => {
		// showStatus uses the global theme instance
		initTheme("dark");
	});

	test("coalesces immediately-sequential status messages", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_ONE");

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// second status updates the previous line instead of appending
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
		expect(renderLastLine(fakeThis.chatContainer)).not.toContain("STATUS_ONE");
	});

	test("appends a new status line if something else was added in between", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);

		// Something else gets added to the chat in between status updates
		fakeThis.chatContainer.addChild({ render: () => ["OTHER"], invalidate: () => {} });
		expect(fakeThis.chatContainer.children).toHaveLength(3);

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// adds spacer + text
		expect(fakeThis.chatContainer.children).toHaveLength(5);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
	});
});

describe("InteractiveMode.createExtensionUIContext setTheme", () => {
	test("persists theme changes to settings manager", () => {
		initTheme("dark");

		let currentTheme = "dark";
		const settingsManager = {
			getTheme: vi.fn(() => currentTheme),
			setTheme: vi.fn((theme: string) => {
				currentTheme = theme;
			}),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("light");

		expect(result.success).toBe(true);
		expect(settingsManager.setTheme).toHaveBeenCalledWith("light");
		expect(currentTheme).toBe("light");
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("does not persist invalid theme names", () => {
		initTheme("dark");

		const settingsManager = {
			getTheme: vi.fn(() => "dark"),
			setTheme: vi.fn(),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("__missing_theme__");

		expect(result.success).toBe(false);
		expect(settingsManager.setTheme).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode working spinner override", () => {
	test("stores working spinner overrides when loader does not exist yet", () => {
		initTheme("dark");

		const fakeThis: any = {
			session: { settingsManager: {} },
			settingsManager: {},
			ui: { requestRender: vi.fn(), terminal: { setTitle: vi.fn() } },
			setExtensionStatus: vi.fn(),
			setHiddenThinkingLabel: vi.fn(),
			setExtensionWidget: vi.fn(),
			setExtensionFooter: vi.fn(),
			setExtensionHeader: vi.fn(),
			showExtensionSelector: vi.fn(),
			showExtensionConfirm: vi.fn(),
			showExtensionInput: vi.fn(),
			showExtensionNotify: vi.fn(),
			addExtensionTerminalInputListener: vi.fn(),
			showExtensionCustom: vi.fn(),
			editor: {
				handleInput: vi.fn(),
				setText: vi.fn(),
				getText: vi.fn(() => ""),
				getExpandedText: vi.fn(() => ""),
			},
			setCustomEditorComponent: vi.fn(),
			workingSpinnerOverride: undefined,
			loadingAnimation: undefined,
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		uiContext.setWorkingSpinner({ frames: ["a", "b"], intervalMs: 120 });

		expect(fakeThis.workingSpinnerOverride).toEqual({ frames: ["a", "b"], intervalMs: 120 });
	});

	test("applies working spinner override immediately when loader already exists", () => {
		initTheme("dark");

		const setFrames = vi.fn();
		const fakeThis: any = {
			session: { settingsManager: {} },
			settingsManager: {},
			ui: { requestRender: vi.fn(), terminal: { setTitle: vi.fn() } },
			setExtensionStatus: vi.fn(),
			setHiddenThinkingLabel: vi.fn(),
			setExtensionWidget: vi.fn(),
			setExtensionFooter: vi.fn(),
			setExtensionHeader: vi.fn(),
			showExtensionSelector: vi.fn(),
			showExtensionConfirm: vi.fn(),
			showExtensionInput: vi.fn(),
			showExtensionNotify: vi.fn(),
			addExtensionTerminalInputListener: vi.fn(),
			showExtensionCustom: vi.fn(),
			editor: {
				handleInput: vi.fn(),
				setText: vi.fn(),
				getText: vi.fn(() => ""),
				getExpandedText: vi.fn(() => ""),
			},
			setCustomEditorComponent: vi.fn(),
			workingSpinnerOverride: undefined,
			loadingAnimation: { setFrames },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		uiContext.setWorkingSpinner({ frames: ["x", "y"], intervalMs: 100 });

		expect(setFrames).toHaveBeenCalledWith(["x", "y"], 100);
		expect(fakeThis.workingSpinnerOverride).toEqual({ frames: ["x", "y"], intervalMs: 100 });
	});

	test("clearing working spinner override resets current loader and future turns", () => {
		initTheme("dark");

		const setFrames = vi.fn();
		const fakeThis: any = {
			session: { settingsManager: {} },
			settingsManager: {},
			ui: { requestRender: vi.fn(), terminal: { setTitle: vi.fn() } },
			setExtensionStatus: vi.fn(),
			setHiddenThinkingLabel: vi.fn(),
			setExtensionWidget: vi.fn(),
			setExtensionFooter: vi.fn(),
			setExtensionHeader: vi.fn(),
			showExtensionSelector: vi.fn(),
			showExtensionConfirm: vi.fn(),
			showExtensionInput: vi.fn(),
			showExtensionNotify: vi.fn(),
			addExtensionTerminalInputListener: vi.fn(),
			showExtensionCustom: vi.fn(),
			editor: {
				handleInput: vi.fn(),
				setText: vi.fn(),
				getText: vi.fn(() => ""),
				getExpandedText: vi.fn(() => ""),
			},
			setCustomEditorComponent: vi.fn(),
			workingSpinnerOverride: { frames: ["x"], intervalMs: 100 },
			loadingAnimation: { setFrames },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		uiContext.setWorkingSpinner();

		expect(setFrames).toHaveBeenCalledWith(undefined, undefined);
		expect(fakeThis.workingSpinnerOverride).toBeUndefined();
	});

	test("agent_start applies configured working spinner override to the main loader", async () => {
		initTheme("dark");

		const fakeThis: any = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			retryEscapeHandler: undefined,
			retryLoader: undefined,
			loadingAnimation: undefined,
			statusContainer: new Container(),
			ui: { requestRender: vi.fn() },
			defaultWorkingMessage: "Working...",
			pendingWorkingMessage: undefined,
			workingSpinnerOverride: { frames: ["x", "y", "z"], intervalMs: 140 },
		};

		await (InteractiveMode as any).prototype.handleEvent.call(fakeThis, { type: "agent_start" });

		expect(fakeThis.loadingAnimation).toBeDefined();
		expect((fakeThis.loadingAnimation as any).frames).toEqual(["x", "y", "z"]);
		expect((fakeThis.loadingAnimation as any).intervalMs).toBe(140);
		expect(fakeThis.workingSpinnerOverride).toEqual({ frames: ["x", "y", "z"], intervalMs: 140 });
	});
});

describe("InteractiveMode.showLoadedResources", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	function createShowLoadedResourcesThis(options: {
		quietStartup: boolean;
		verbose?: boolean;
		skills?: Array<{ filePath: string }>;
		skillDiagnostics?: Array<{ type: "warning" | "error" | "collision"; message: string }>;
	}) {
		const fakeThis: any = {
			options: { verbose: options.verbose ?? false },
			chatContainer: new Container(),
			settingsManager: {
				getQuietStartup: () => options.quietStartup,
			},
			session: {
				promptTemplates: [],
				extensionRunner: undefined,
				resourceLoader: {
					getPathMetadata: () => new Map(),
					getAgentsFiles: () => ({ agentsFiles: [] }),
					getSkills: () => ({
						skills: options.skills ?? [],
						diagnostics: options.skillDiagnostics ?? [],
					}),
					getPrompts: () => ({ prompts: [], diagnostics: [] }),
					getExtensions: () => ({ extensions: [], errors: [], runtime: {} }),
					getThemes: () => ({ themes: [], diagnostics: [] }),
				},
			},
			formatDisplayPath: (p: string) => p,
			buildScopeGroups: () => [],
			formatScopeGroups: () => "resource-list",
			getShortPath: (p: string) => p,
			formatDiagnostics: () => "diagnostics",
			getBuiltInCommandConflictDiagnostics: () => [],
		};

		return fakeThis;
	}

	test("does not show verbose listing on quiet startup during reload", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			extensions: [{ path: "/tmp/ext/index.ts" }],
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		expect(fakeThis.chatContainer.children).toHaveLength(0);
	});

	test("still shows diagnostics on quiet startup when requested", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md" }],
			skillDiagnostics: [{ type: "warning", message: "duplicate skill name" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Skill conflicts]");
		expect(output).not.toContain("[Skills]");
	});
});
