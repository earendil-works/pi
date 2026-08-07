import { type Component, Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory, ResourceLoader } from "../../../src/index.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { createTestExtensionsResult } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

const TOOL_NAME = "session_start_tool";

type ReloadContext = {
	hideThinkingBlock: boolean;
	outputPad: 0 | 1;
	session: Harness["session"];
	settingsManager: Harness["settingsManager"];
	keybindings: { reload(): void };
	editorContainer: Container;
	ui: {
		setFocus(component: Component): void;
		requestRender(force?: boolean): void;
	};
	editor: Component;
	themeController: { applyFromSettings(): Promise<void> };
	resetExtensionUI(): void;
	rebuildChatFromMessages(): void;
	refreshToolRenderers(): void;
	applyRuntimeSettings(): void;
	setupAutocompleteProvider(): void;
	setupExtensionShortcuts(): void;
	showLoadedResources(): void;
	maybeSaveImplicitProjectTrustAfterReload(): boolean;
	showStatus(message: string): void;
	showWarning(message: string): void;
	showError(message: string): void;
};

type HandleReloadCommand = (this: ReloadContext) => Promise<void>;

const handleReloadCommand = (InteractiveMode.prototype as unknown as { handleReloadCommand: HandleReloadCommand })
	.handleReloadCommand;

describe("issue #7740 reload tool renderers", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("refreshes historical tool calls after session_start registers custom renderers", async () => {
		const factory: ExtensionFactory = (pi) => {
			pi.on("session_start", () => {
				pi.registerTool({
					name: TOOL_NAME,
					label: "Session Start Tool",
					description: "Tool registered from session_start",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
					renderCall: () => new Text("custom call", 0, 0),
					renderResult: () => new Text("custom result", 0, 0),
				});
			});
		};
		const loadExtensions = () => createTestExtensionsResult([{ factory, path: "<issue-7740>" }]);
		let extensionsResult = await loadExtensions();
		const resourceLoader: ResourceLoader = {
			getExtensions: () => extensionsResult,
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => undefined,
			getSystemPromptSource: () => undefined,
			getAppendSystemPrompt: () => [],
			getAppendSystemPromptSources: () => [],
			extendResources: () => {},
			reload: async () => {
				extensionsResult = await loadExtensions();
			},
		};
		const harness = await createHarness({ resourceLoader });

		try {
			await harness.session.bindExtensions({ shutdownHandler: () => {} });
			expect(harness.session.getToolDefinition(TOOL_NAME)?.renderCall).toBeDefined();

			const rendererAvailability: boolean[] = [];
			const editor = new Text("", 0, 0);
			const context: ReloadContext = {
				hideThinkingBlock: false,
				outputPad: 1,
				session: harness.session,
				settingsManager: harness.settingsManager,
				keybindings: { reload: vi.fn() },
				editorContainer: new Container(),
				ui: { setFocus: vi.fn(), requestRender: vi.fn() },
				editor,
				themeController: { applyFromSettings: async () => {} },
				resetExtensionUI: vi.fn(),
				rebuildChatFromMessages: () => {
					const definition = harness.session.getToolDefinition(TOOL_NAME);
					rendererAvailability.push(Boolean(definition?.renderCall && definition.renderResult));
				},
				refreshToolRenderers: () => {
					const definition = harness.session.getToolDefinition(TOOL_NAME);
					rendererAvailability.push(Boolean(definition?.renderCall && definition.renderResult));
				},
				applyRuntimeSettings: vi.fn(),
				setupAutocompleteProvider: vi.fn(),
				setupExtensionShortcuts: vi.fn(),
				showLoadedResources: vi.fn(),
				maybeSaveImplicitProjectTrustAfterReload: () => false,
				showStatus: vi.fn(),
				showWarning: vi.fn(),
				showError: vi.fn(),
			};

			await handleReloadCommand.call(context);

			expect(rendererAvailability).toEqual([false, true]);
		} finally {
			harness.cleanup();
		}
	});
});
