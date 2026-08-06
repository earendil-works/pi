import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import type { SessionInfo } from "../../../src/core/session-manager.ts";
import { CustomEditor } from "../../../src/modes/interactive/components/custom-editor.ts";
import { ExtensionSelectorComponent } from "../../../src/modes/interactive/components/extension-selector.ts";
import { FirstTimeSetupComponent } from "../../../src/modes/interactive/components/first-time-setup.ts";
import { ModelSelectorComponent } from "../../../src/modes/interactive/components/model-selector.ts";
import { OAuthSelectorComponent } from "../../../src/modes/interactive/components/oauth-selector.ts";
import { ScopedModelsSelectorComponent } from "../../../src/modes/interactive/components/scoped-models-selector.ts";
import { SessionSelectorComponent } from "../../../src/modes/interactive/components/session-selector.ts";
import { ShowImagesSelectorComponent } from "../../../src/modes/interactive/components/show-images-selector.ts";
import { ThemeSelectorComponent } from "../../../src/modes/interactive/components/theme-selector.ts";
import { ThinkingSelectorComponent } from "../../../src/modes/interactive/components/thinking-selector.ts";
import { TrustSelectorComponent } from "../../../src/modes/interactive/components/trust-selector.ts";
import { UserMessageSelectorComponent } from "../../../src/modes/interactive/components/user-message-selector.ts";
import { getEditorTheme, initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, type Harness } from "../harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

const REMAPPED_PAGE_KEYS = {
	"tui.editor.pageUp": "alt+v",
	"tui.editor.pageDown": "ctrl+v",
	"tui.select.pageUp": "alt+v",
	"tui.select.pageDown": "ctrl+v",
} as const;

describe("issue #7629 selection page key handling", () => {
	let harness: Harness | undefined;

	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		setKeybindings(new KeybindingsManager(REMAPPED_PAGE_KEYS));
	});
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		setKeybindings(new KeybindingsManager());
		vi.restoreAllMocks();
	});

	it("pages through model selectors with remapped keys", async () => {
		harness = await createHarness({
			models: Array.from({ length: 12 }, (_, index) => ({
				id: `model-${index}`,
				name: `Model ${index}`,
			})),
		});
		const onModelSelect = vi.fn();
		const modelSelector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.settingsManager,
			harness.session.modelRuntime,
			harness.models.map((model) => ({ model })),
			onModelSelect,
			() => {},
		);

		await vi.waitFor(() => {
			expect(stripAnsi(modelSelector.render(120).join("\n"))).toContain("Model catalogs refreshed.");
		});
		modelSelector.handleInput("\x16");
		modelSelector.handleInput("\r");
		expect(onModelSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "model-10" }));

		const onScopedChange = vi.fn();
		const scopedSelector = new ScopedModelsSelectorComponent(
			{ allModels: harness.models, enabledModelIds: null },
			{
				onChange: onScopedChange,
				onPersist: () => {},
				onCancel: () => {},
			},
		);
		scopedSelector.handleInput("\x16");
		scopedSelector.handleInput("\r");
		expect(onScopedChange).toHaveBeenCalledWith([`${harness.models[8].provider}/model-8`]);
	});

	it("prioritizes autocomplete page keys over the image paste shortcut", async () => {
		const keybindings = new KeybindingsManager(REMAPPED_PAGE_KEYS);
		setKeybindings(keybindings);
		const editor = new CustomEditor(createFakeTui(), getEditorTheme(), keybindings);
		const onPasteImage = vi.fn();
		let submitted = "";
		editor.onPasteImage = onPasteImage;
		editor.onSubmit = (text) => {
			submitted = text;
		};
		editor.setAutocompleteProvider({
			getSuggestions: async () => ({
				items: Array.from({ length: 12 }, (_, index) => ({
					value: `/command-${index}`,
					label: `command-${index}`,
				})),
				prefix: "/",
			}),
			applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
				const newLines = [...lines];
				newLines[cursorLine] = (lines[cursorLine] ?? "").slice(0, cursorCol - prefix.length) + item.value;
				return { lines: newLines, cursorLine, cursorCol: item.value.length };
			},
		});

		editor.handleInput("/");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
		editor.handleInput("\x16");
		editor.handleInput("\r");

		expect(onPasteImage).not.toHaveBeenCalled();
		expect(submitted).toBe("/command-5");
	});

	it("keeps the session selection valid when paging before sessions load", async () => {
		let completeLoad: (sessions: SessionInfo[]) => void = () => {
			throw new Error("Session load did not start");
		};
		const pendingSessions = new Promise<SessionInfo[]>((resolve) => {
			completeLoad = resolve;
		});
		const onSelect = vi.fn();
		const selector = new SessionSelectorComponent(
			async () => pendingSessions,
			async () => [],
			onSelect,
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager(REMAPPED_PAGE_KEYS) },
		);

		selector.getSessionList().handleInput("\x16");
		completeLoad([
			{
				path: "/tmp/session.jsonl",
				id: "session",
				cwd: "/tmp",
				created: new Date(0),
				modified: new Date(0),
				messageCount: 1,
				firstMessage: "hello",
				allMessagesText: "hello",
			},
		]);
		await vi.waitFor(() => expect(selector.render(120).join("\n")).toContain("hello"));
		selector.getSessionList().handleInput("\r");

		expect(onSelect).toHaveBeenCalledWith("/tmp/session.jsonl");
	});

	it("pages through standalone selectors with remapped keys", () => {
		const onOAuthSelect = vi.fn();
		const oauthSelector = new OAuthSelectorComponent(
			"login",
			Array.from({ length: 10 }, (_, index) => ({
				id: `provider-${index}`,
				name: `Provider ${index}`,
				authType: "api_key" as const,
			})),
			onOAuthSelect,
			() => {},
		);
		oauthSelector.handleInput("\x16");
		oauthSelector.handleInput("\r");
		expect(onOAuthSelect).toHaveBeenCalledWith("provider-8", "api_key");

		const onExtensionSelect = vi.fn();
		const extensionSelector = new ExtensionSelectorComponent(
			"Select",
			Array.from({ length: 10 }, (_, index) => `option-${index}`),
			onExtensionSelect,
			() => {},
		);
		extensionSelector.handleInput("\x16");
		extensionSelector.handleInput("\r");
		expect(onExtensionSelect).toHaveBeenCalledWith("option-8");

		const onMessageSelect = vi.fn();
		const messageSelector = new UserMessageSelectorComponent(
			Array.from({ length: 12 }, (_, index) => ({ id: `message-${index}`, text: `Message ${index}` })),
			onMessageSelect,
			() => {},
		);
		messageSelector.getMessageList().handleInput("\x1bv");
		messageSelector.getMessageList().handleInput("\r");
		expect(onMessageSelect).toHaveBeenCalledWith("message-1");

		const onTrustSelect = vi.fn();
		const trustSelector = new TrustSelectorComponent({
			cwd: "/project",
			savedDecision: null,
			projectTrusted: false,
			onSelect: onTrustSelect,
			onCancel: () => {},
		});
		trustSelector.handleInput("\x16");
		trustSelector.handleInput("\r");
		expect(onTrustSelect).toHaveBeenCalledWith({
			trusted: false,
			updates: [{ path: "/project", decision: false }],
		});
	});

	it("pages through SelectList-backed selectors", () => {
		const onThemePreview = vi.fn();
		const setup = new FirstTimeSetupComponent({
			detectedTheme: "dark",
			onThemePreview,
			onSubmit: () => {},
			onCancel: () => {},
		});
		setup.handleInput("\x16");
		expect(onThemePreview).toHaveBeenCalledWith("light");

		const onThinkingSelect = vi.fn();
		const thinkingSelector = new ThinkingSelectorComponent(
			"off",
			["off", "minimal", "low", "medium", "high", "xhigh", "max"],
			onThinkingSelect,
			() => {},
		);
		thinkingSelector.getSelectList().handleInput("\x16");
		thinkingSelector.getSelectList().handleInput("\r");
		expect(onThinkingSelect).toHaveBeenCalledWith("max");

		const onShowImagesSelect = vi.fn();
		const showImagesSelector = new ShowImagesSelectorComponent(true, onShowImagesSelect, () => {});
		showImagesSelector.getSelectList().handleInput("\x16");
		showImagesSelector.getSelectList().handleInput("\r");
		expect(onShowImagesSelect).toHaveBeenCalledWith(false);

		const onThemeSelect = vi.fn();
		const themeSelector = new ThemeSelectorComponent(
			"dark",
			onThemeSelect,
			() => {},
			() => {},
		);
		themeSelector.getSelectList().handleInput("\x16");
		themeSelector.getSelectList().handleInput("\r");
		expect(onThemeSelect).toHaveBeenCalledOnce();
	});
});
