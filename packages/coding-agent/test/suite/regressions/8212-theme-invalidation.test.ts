import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container, Markdown, type Spacer, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { AssistantMessageComponent } from "../../../src/modes/interactive/components/assistant-message.ts";
import { type DynamicText, ExpandableText } from "../../../src/modes/interactive/components/dynamic-text.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../../../src/modes/interactive/components/settings-selector.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import {
	getMarkdownTheme,
	initTheme,
	setThemeInstance,
	Theme,
	type ThemeBg,
	type ThemeColor,
	theme,
} from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness } from "../harness.ts";

const FG_COLORS = [
	"accent",
	"border",
	"borderAccent",
	"borderMuted",
	"success",
	"error",
	"warning",
	"muted",
	"dim",
	"text",
	"thinkingText",
	"searchMatchText",
	"userMessageText",
	"customMessageText",
	"customMessageLabel",
	"toolTitle",
	"toolOutput",
	"mdHeading",
	"mdLink",
	"mdLinkUrl",
	"mdCode",
	"mdCodeBlock",
	"mdCodeBlockBorder",
	"mdQuote",
	"mdQuoteBorder",
	"mdHr",
	"mdListBullet",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolDiffContext",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"thinkingMax",
	"bashMode",
] as const satisfies readonly ThemeColor[];

const BG_COLORS = [
	"selectedBg",
	"scrollbarThumb",
	"searchMatchBg",
	"userMessageBg",
	"customMessageBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
] as const satisfies readonly ThemeBg[];

function createSolidTheme(foreground: string, background: string): Theme {
	const foregrounds = Object.fromEntries(FG_COLORS.map((color) => [color, foreground])) as ConstructorParameters<
		typeof Theme
	>[0];
	const backgrounds = Object.fromEntries(BG_COLORS.map((color) => [color, background])) as ConstructorParameters<
		typeof Theme
	>[1];
	return new Theme(foregrounds, backgrounds, "truecolor");
}

type TranscriptContext = {
	chatContainer: Container;
	lastStatusSpacer: Spacer | undefined;
	lastStatusText: DynamicText<string> | undefined;
	outputPad: number;
	ui: { requestRender: () => void };
};

type TranscriptPrototype = {
	showError(this: TranscriptContext, message: string): void;
	showWarning(this: TranscriptContext, message: string): void;
	showStatus(this: TranscriptContext, message: string): void;
};

type SettingsListState = {
	selectedIndex: number;
	searchInput?: { getValue(): string };
};

const transcriptPrototype = InteractiveMode.prototype as unknown as TranscriptPrototype;

describe("regression #8212: theme invalidation", () => {
	afterEach(() => {
		initTheme("dark");
	});

	it("removes the old palette from the first invalidated built-in frame without changing state", async () => {
		setKeybindings(new KeybindingsManager());
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("assistant **markdown**")]);

		try {
			await harness.session.prompt("user message");
			await harness.session.agent.waitForIdle();
			const assistantMessage = harness.session.messages.find(
				(message): message is AssistantMessage => message.role === "assistant",
			);
			expect(assistantMessage).toBeDefined();

			const oldTheme = createSolidTheme("#010203", "#040506");
			const newTheme = createSolidTheme("#a1b2c3", "#d4e5f6");
			setThemeInstance(oldTheme);

			const root = new Container();
			root.addChild(new AssistantMessageComponent(assistantMessage));
			root.addChild(
				new Markdown("default `code` text", 1, 0, getMarkdownTheme(), {
					color: (text) => theme.fg("text", text),
				}),
			);

			const transcriptContext: TranscriptContext = {
				chatContainer: new Container(),
				lastStatusSpacer: undefined,
				lastStatusText: undefined,
				outputPad: 1,
				ui: { requestRender: () => {} },
			};
			transcriptPrototype.showWarning.call(transcriptContext, "warning text");
			transcriptPrototype.showError.call(transcriptContext, "error text");
			transcriptPrototype.showStatus.call(transcriptContext, "old status");
			transcriptPrototype.showStatus.call(transcriptContext, "current status");
			root.addChild(transcriptContext.chatContainer);

			const header = new ExpandableText(
				() => theme.fg("dim", "collapsed header"),
				() => theme.fg("accent", "expanded header"),
				true,
			);
			header.setExpanded(false);
			root.addChild(header);

			const settings = new SettingsSelectorComponent(
				{
					autoCompact: true,
					showImages: false,
					imageWidthCells: 80,
					autoResizeImages: true,
					blockImages: false,
					enableSkillCommands: true,
					steeringMode: "all",
					followUpMode: "all",
					transport: "sse",
					httpIdleTimeoutMs: 300_000,
					thinkingLevel: "off",
					currentTheme: "test",
					terminalTheme: "dark",
					availableThemes: ["test"],
					availableThinkingLevels: ["off"],
					hideThinkingBlock: false,
					mermaidRenderingMode: "off",
					showCacheMissNotices: true,
					collapseChangelog: false,
					enableInstallTelemetry: false,
					doubleEscapeAction: "tree",
					treeFilterMode: "default",
					showHardwareCursor: false,
					editorPaddingX: 1,
					outputPad: 1,
					autocompleteMaxVisible: 10,
					quietStartup: false,
					defaultProjectTrust: "ask",
					clearOnShrink: false,
					showTerminalProgress: false,
					tuiMode: "regular",
					fullscreenExitOutput: "transcript",
					fullscreenScrollbar: "auto",
					warnings: {},
				} satisfies SettingsConfig,
				{ onCancel: () => {} } as unknown as SettingsCallbacks,
			);
			const settingsList = settings.getSettingsList();
			for (const character of "e") settingsList.handleInput(character);
			settingsList.handleInput("\x1b[B");
			settingsList.handleInput("\x1b[B");
			root.addChild(settings);

			const settingsState = settingsList as unknown as SettingsListState;
			const selectedIndex = settingsState.selectedIndex;
			const searchQuery = settingsState.searchInput?.getValue();
			const oldFrame = root.render(120).join("\n");
			const visibleFrame = stripAnsi(oldFrame);
			const oldForeground = oldTheme.getFgAnsi("accent");
			const oldBackground = oldTheme.getBgAnsi("selectedBg");

			expect(oldFrame).toContain(oldForeground);
			setThemeInstance(newTheme);
			root.invalidate();
			const newFrame = root.render(120).join("\n");

			expect(newFrame).not.toContain(oldForeground);
			expect(newFrame).not.toContain(oldBackground);
			expect(newFrame).toContain(newTheme.getFgAnsi("accent"));
			expect(stripAnsi(newFrame)).toBe(visibleFrame);
			expect(settingsState.selectedIndex).toBe(selectedIndex);
			expect(settingsState.searchInput?.getValue()).toBe(searchQuery);
			expect(stripAnsi(header.render(120).join("\n"))).toContain("collapsed header");
			expect(stripAnsi(header.render(120).join("\n"))).not.toContain("expanded header");
		} finally {
			harness.cleanup();
		}
	});
});
