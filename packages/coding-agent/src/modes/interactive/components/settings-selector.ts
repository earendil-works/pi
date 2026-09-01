import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, type Model, type Transport } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	getCapabilities,
	type ScrollViewScrollbar,
	type SelectItem,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { formatHttpIdleTimeoutMs, HTTP_IDLE_TIMEOUT_CHOICES } from "../../../core/http-dispatcher.ts";
import type {
	DefaultProjectTrust,
	FullscreenExitOutput,
	MermaidRenderingMode,
	TuiMode,
	WarningSettings,
} from "../../../core/settings-manager.ts";
import { getSettingsListTheme, parseAutoThemeSetting, type TerminalTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyDisplayText } from "./keybinding-hints.ts";
import { SelectSubmenu, SteppedSubmenu, type SteppedSubmenuStep } from "./settings-submenu.ts";

const MODEL_PICKER_LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 46 };

const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Extra-high reasoning (~32k tokens)",
	max: "Maximum reasoning",
};

const DEFAULT_PROJECT_TRUST_LABELS: Record<DefaultProjectTrust, string> = {
	ask: "Ask",
	always: "Always trust",
	never: "Never trust",
};

const DEFAULT_PROJECT_TRUST_BY_LABEL = new Map(
	Object.entries(DEFAULT_PROJECT_TRUST_LABELS).map(([value, label]) => [label, value as DefaultProjectTrust]),
);

export interface SettingsConfig {
	autoCompact: boolean;
	defaultModel: string;
	currentModel?: Model<any>;
	availableDefaultModels: readonly Model<any>[];
	showImages: boolean;
	imageWidthCells: number;
	autoResizeImages: boolean;
	blockImages: boolean;
	enableSkillCommands: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	transport: Transport;
	httpIdleTimeoutMs: number;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	modelThinkingLevels: Record<string, ThinkingLevel>;
	currentTheme: string;
	terminalTheme: TerminalTheme;
	availableThemes: string[];
	hideThinkingBlock: boolean;
	mermaidRenderingMode: MermaidRenderingMode;
	showCacheMissNotices: boolean;
	collapseChangelog: boolean;
	enableInstallTelemetry: boolean;
	doubleEscapeAction: "fork" | "tree" | "none";
	treeFilterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
	showHardwareCursor: boolean;
	editorPaddingX: number;
	outputPad: 0 | 1;
	autocompleteMaxVisible: number;
	quietStartup: boolean;
	defaultProjectTrust: DefaultProjectTrust;
	clearOnShrink: boolean;
	showTerminalProgress: boolean;
	tuiMode: TuiMode;
	fullscreenExitOutput: FullscreenExitOutput;
	fullscreenScrollbar: ScrollViewScrollbar;
	fullscreenCopyOnSelect: boolean;
	warnings: WarningSettings;
}

export interface SettingsCallbacks {
	onAutoCompactChange: (enabled: boolean) => void;
	onShowImagesChange: (enabled: boolean) => void;
	onImageWidthCellsChange: (width: number) => void;
	onAutoResizeImagesChange: (enabled: boolean) => void;
	onBlockImagesChange: (blocked: boolean) => void;
	onEnableSkillCommandsChange: (enabled: boolean) => void;
	onSteeringModeChange: (mode: "all" | "one-at-a-time") => void;
	onFollowUpModeChange: (mode: "all" | "one-at-a-time") => void;
	onTransportChange: (transport: Transport) => void;
	onHttpIdleTimeoutMsChange: (timeoutMs: number) => void;
	onModelThinkingLevelChange: (provider: string, modelId: string, level: ThinkingLevel) => void;
	onModelThinkingLevelRemove: (provider: string, modelId: string) => void;
	onThemeChange: (theme: string) => void;
	onThemePreview?: (theme: string) => void;
	onHideThinkingBlockChange: (hidden: boolean) => void;
	onMermaidRenderingModeChange: (mode: MermaidRenderingMode) => void;
	onShowCacheMissNoticesChange: (shown: boolean) => void;
	onCollapseChangelogChange: (collapsed: boolean) => void;
	onEnableInstallTelemetryChange: (enabled: boolean) => void;
	onDoubleEscapeActionChange: (action: "fork" | "tree" | "none") => void;
	onTreeFilterModeChange: (mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all") => void;
	onShowHardwareCursorChange: (enabled: boolean) => void;
	onEditorPaddingXChange: (padding: number) => void;
	onOutputPadChange: (padding: 0 | 1) => void;
	onAutocompleteMaxVisibleChange: (maxVisible: number) => void;
	onQuietStartupChange: (enabled: boolean) => void;
	onDefaultProjectTrustChange: (defaultProjectTrust: DefaultProjectTrust) => void;
	onClearOnShrinkChange: (enabled: boolean) => void;
	onShowTerminalProgressChange: (enabled: boolean) => void;
	onTuiModeChange: (mode: TuiMode) => void;
	onFullscreenExitOutputChange: (output: FullscreenExitOutput) => void;
	onFullscreenScrollbarChange: (mode: ScrollViewScrollbar) => void;
	onFullscreenCopyOnSelectChange: (enabled: boolean) => void;
	onWarningsChange: (warnings: WarningSettings) => void;
	onCancel: () => void;
}

/**
 * A submenu component for selecting from a list of options.
 */
class WarningSettingsSubmenu extends Container {
	private settingsList: SettingsList;
	private state: WarningSettings;

	constructor(warnings: WarningSettings, onChange: (warnings: WarningSettings) => void, onCancel: () => void) {
		super();

		this.state = { ...warnings };

		const items: SettingItem[] = [
			{
				id: "anthropic-extra-usage",
				label: "Anthropic extra usage",
				description: "Warn when Anthropic subscription auth may use paid extra usage",
				currentValue: (this.state.anthropicExtraUsage ?? true) ? "true" : "false",
				values: ["true", "false"],
			},
		];

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "anthropic-extra-usage":
						this.state = { ...this.state, anthropicExtraUsage: newValue === "true" };
						onChange({ ...this.state });
						break;
				}
			},
			onCancel,
		);

		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

const CLEAR_OVERRIDE_VALUE = "__clear__";

function modelSettingKey(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function modelDisplayLabel(model: Model<any>): string {
	return `${model.id} [${model.provider}]`;
}

function modelThinkingOverridesSummary(overrides: Record<string, ThinkingLevel>): string {
	const count = Object.keys(overrides).length;
	if (count === 0) return "none";
	return `${count} configured`;
}

function modelItemLabel(model: Model<any>): string {
	return `${model.id} ${theme.fg("muted", `[${model.provider}]`)}`;
}

function themeItems(availableThemes: string[], currentTheme: string): SelectItem[] {
	return availableThemes.map((name) => ({
		value: name,
		label: `${name === currentTheme ? "✓ " : "  "}${name}`,
	}));
}

const AUTOMATIC_THEME_VALUE = "/";

function singleModeThemeItems(availableThemes: string[], currentTheme: string): SelectItem[] {
	return [
		{
			value: AUTOMATIC_THEME_VALUE,
			label: "  Automatic",
			description: "Use separate themes for light and dark terminal appearance",
		},
		...themeItems(availableThemes, currentTheme),
	];
}

function preferredTheme(availableThemes: string[], preferred: string | undefined, fallback: string): string {
	if (preferred && availableThemes.includes(preferred)) return preferred;
	if (availableThemes.includes(fallback)) return fallback;
	return availableThemes[0] ?? fallback;
}

function defaultAutomaticThemes(
	currentThemeSetting: string,
	availableThemes: string[],
): { lightTheme: string; darkTheme: string } {
	const autoTheme = parseAutoThemeSetting(currentThemeSetting);
	if (autoTheme) return autoTheme;

	const currentFixedTheme = currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
	const themeName = preferredTheme(availableThemes, currentFixedTheme, "dark");
	return { lightTheme: themeName, darkTheme: themeName };
}

class ThemeSubmenu extends Container {
	private inputComponent: Component | undefined;
	private readonly callbacks: SettingsCallbacks;
	private readonly availableThemes: string[];
	private readonly terminalTheme: TerminalTheme;
	private readonly onDone: (selectedValue?: string) => void;
	private readonly originalThemeSetting: string;
	private mode: "single" | "automatic";
	private singleTheme: string;
	private lightTheme: string;
	private darkTheme: string;

	constructor(
		currentThemeSetting: string,
		terminalTheme: TerminalTheme,
		availableThemes: string[],
		callbacks: SettingsCallbacks,
		onDone: (selectedValue?: string) => void,
	) {
		super();
		this.callbacks = callbacks;
		this.availableThemes = availableThemes;
		this.terminalTheme = terminalTheme;
		this.onDone = onDone;
		this.originalThemeSetting = currentThemeSetting;
		const autoTheme = parseAutoThemeSetting(currentThemeSetting);
		const automaticThemes = defaultAutomaticThemes(currentThemeSetting, availableThemes);
		const fixedTheme = autoTheme || currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
		this.mode = autoTheme ? "automatic" : "single";
		this.lightTheme = automaticThemes.lightTheme;
		this.darkTheme = automaticThemes.darkTheme;
		this.singleTheme = preferredTheme(
			availableThemes,
			fixedTheme ?? (autoTheme ? this.getActiveAutomaticTheme() : undefined),
			"dark",
		);

		if (this.mode === "automatic") {
			this.showAutomaticMenu();
		} else {
			this.showSingleMenu();
		}
	}

	handleInput(data: string): void {
		this.inputComponent?.handleInput?.(data);
	}

	private setContent(renderComponent: Component, inputComponent: Component = renderComponent): void {
		this.clear();
		this.addChild(renderComponent);
		this.inputComponent = inputComponent;
	}

	private showSingleMenu(): void {
		this.mode = "single";
		const menu = new SelectSubmenu(
			"Theme",
			"Select a theme, or choose Automatic to follow terminal appearance.",
			singleModeThemeItems(this.availableThemes, this.singleTheme),
			this.singleTheme,
			(value) => {
				if (value === AUTOMATIC_THEME_VALUE) {
					this.mode = "automatic";
					this.callbacks.onThemePreview?.(this.getThemeSetting());
					this.showAutomaticMenu();
					return;
				}

				this.singleTheme = value;
				this.apply(value);
			},
			() => this.cancel(),
			(value) => {
				this.callbacks.onThemePreview?.(value === AUTOMATIC_THEME_VALUE ? this.getAutomaticThemeSetting() : value);
			},
		);
		this.setContent(menu);
	}

	private showAutomaticMenu(): void {
		this.mode = "automatic";
		const content = new Container();
		content.addChild(new Text(theme.bold(theme.fg("accent", "Automatic Theme")), 0, 0));
		content.addChild(new Spacer(1));
		content.addChild(new Text(theme.fg("muted", "Choose themes for terminal light and dark appearance."), 0, 0));
		content.addChild(new Text(theme.fg("muted", "Light/dark detection requires terminal support."), 0, 0));
		content.addChild(new Spacer(1));

		const items: SettingItem[] = [
			{
				id: "light-theme",
				label: "Light theme",
				description: "Theme to use in automatic mode when the terminal is light",
				currentValue: this.lightTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect(
						"Light Theme",
						"Select the theme to use for light terminal appearance",
						currentValue,
						done,
						(value) => {
							this.lightTheme = value;
							this.callbacks.onThemePreview?.(this.getThemeSetting());
							done(value);
						},
					),
			},
			{
				id: "dark-theme",
				label: "Dark theme",
				description: "Theme to use in automatic mode when the terminal is dark",
				currentValue: this.darkTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect(
						"Dark Theme",
						"Select the theme to use for dark terminal appearance",
						currentValue,
						done,
						(value) => {
							this.darkTheme = value;
							this.callbacks.onThemePreview?.(this.getThemeSetting());
							done(value);
						},
					),
			},
			{
				id: "apply",
				label: "Apply",
				description: "Save and go back",
				currentValue: "save and go back",
				values: ["save and go back"],
			},
			{
				id: "single-mode",
				label: "Change mode",
				description: "Switch to one theme for light and dark",
				currentValue: "switch to single theme",
				values: ["switch to single theme"],
			},
		];

		const settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id) => {
				switch (id) {
					case "single-mode":
						this.mode = "single";
						this.singleTheme = this.getActiveAutomaticTheme();
						this.callbacks.onThemePreview?.(this.singleTheme);
						this.showSingleMenu();
						break;
					case "apply":
						this.apply(this.getAutomaticThemeSetting());
						break;
				}
			},
			() => this.cancel(),
		);
		content.addChild(settingsList);
		this.setContent(content, settingsList);
	}

	private createThemeSelect(
		title: string,
		description: string,
		currentValue: string,
		done: (selectedValue?: string) => void,
		onSelect: (value: string) => void,
	): SelectSubmenu {
		return new SelectSubmenu(
			title,
			description,
			themeItems(this.availableThemes, currentValue),
			currentValue,
			onSelect,
			() => {
				this.callbacks.onThemePreview?.(this.getThemeSetting());
				done();
			},
			(value) => this.callbacks.onThemePreview?.(value),
		);
	}

	private getThemeSetting(): string {
		return this.mode === "automatic" ? this.getAutomaticThemeSetting() : this.singleTheme;
	}

	private getActiveAutomaticTheme(): string {
		return this.terminalTheme === "light" ? this.lightTheme : this.darkTheme;
	}

	private getAutomaticThemeSetting(): string {
		return `${this.lightTheme}/${this.darkTheme}`;
	}

	private apply(themeSetting: string): void {
		this.onDone(themeSetting);
	}

	private cancel(): void {
		this.callbacks.onThemePreview?.(this.originalThemeSetting);
		this.onDone();
	}
}

/**
 * Main settings selector component.
 */
export class SettingsSelectorComponent extends Container {
	private settingsList: SettingsList;

	constructor(config: SettingsConfig, callbacks: SettingsCallbacks) {
		super();

		const supportsImages = getCapabilities().images;
		const followUpKey = keyDisplayText("app.message.followUp");
		const cycleThinkingKey = keyDisplayText("app.thinking.cycle");
		let currentWarnings = { ...config.warnings };
		const currentModelThinkingLevels = { ...config.modelThinkingLevels };
		const defaultModelByValue = new Map(
			config.availableDefaultModels.map((model) => [modelSettingKey(model), model]),
		);
		const currentDefaultModelKey = defaultModelByValue.has(config.defaultModel) ? config.defaultModel : undefined;
		const currentModelKey = config.currentModel ? modelSettingKey(config.currentModel) : undefined;

		const items: SettingItem[] = [
			{
				id: "autocompact",
				label: "Auto-compact",
				description: "Automatically compact context when it gets too large",
				currentValue: config.autoCompact ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "steering-mode",
				label: "Steering mode",
				description:
					"Enter while streaming queues steering messages. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.",
				currentValue: config.steeringMode,
				values: ["one-at-a-time", "all"],
			},
			{
				id: "follow-up-mode",
				label: "Follow-up mode",
				description: `${followUpKey} queues follow-up messages until agent stops. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.`,
				currentValue: config.followUpMode,
				values: ["one-at-a-time", "all"],
			},
			{
				id: "transport",
				label: "Transport",
				description: "Preferred transport for providers that support multiple transports",
				currentValue: config.transport,
				values: ["sse", "websocket", "websocket-cached", "auto"],
			},
			{
				id: "http-idle-timeout",
				label: "HTTP idle timeout",
				description:
					"Maximum idle gap while waiting for HTTP headers or body chunks. Disable for local models that pause longer than five minutes.",
				currentValue: formatHttpIdleTimeoutMs(config.httpIdleTimeoutMs),
				values: HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => choice.label),
			},
			{
				id: "hide-thinking",
				label: "Hide thinking",
				description: "Hide thinking blocks in assistant responses",
				currentValue: config.hideThinkingBlock ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "mermaid-rendering",
				label: "Mermaid diagrams",
				description: "Render Mermaid code blocks as Unicode diagrams",
				currentValue: config.mermaidRenderingMode,
				values: ["off", "final", "streaming"],
			},
			{
				id: "cache-miss-notices",
				label: "Cache miss notices",
				description: "Show transcript notices for significant prompt-cache misses and compaction costs",
				currentValue: config.showCacheMissNotices ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "collapse-changelog",
				label: "Collapse changelog",
				description: "Show condensed changelog after updates",
				currentValue: config.collapseChangelog ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "quiet-startup",
				label: "Quiet startup",
				description: "Disable verbose printing at startup",
				currentValue: config.quietStartup ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "install-telemetry",
				label: "Install telemetry",
				description: "Send an anonymous version/update ping after changelog-detected updates",
				currentValue: config.enableInstallTelemetry ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "default-project-trust",
				label: "Default project trust",
				description: "Fallback behavior when no extension or saved trust decision decides project trust",
				currentValue: DEFAULT_PROJECT_TRUST_LABELS[config.defaultProjectTrust],
				values: Object.values(DEFAULT_PROJECT_TRUST_LABELS),
			},
			{
				id: "double-escape-action",
				label: "Double-escape action",
				description: "Action when pressing Escape twice with empty editor",
				currentValue: config.doubleEscapeAction,
				values: ["tree", "fork", "none"],
			},
			{
				id: "tree-filter-mode",
				label: "Tree filter mode",
				description: "Default filter when opening /tree",
				currentValue: config.treeFilterMode,
				values: ["default", "no-tools", "user-only", "labeled-only", "all"],
			},
			{
				id: "warnings",
				label: "Warnings",
				description: "Enable or disable individual warnings",
				currentValue: "configure",
				submenu: (_currentValue, done) =>
					new WarningSettingsSubmenu(
						currentWarnings,
						(warnings) => {
							currentWarnings = warnings;
							callbacks.onWarningsChange(warnings);
						},
						() => done(),
					),
			},
			{
				id: "model-thinking",
				label: "Default thinking level per model",
				description: `Override the default thinking level for specific models. ${cycleThinkingKey} cycles in-session.`,
				currentValue: modelThinkingOverridesSummary(currentModelThinkingLevels),
				submenu: (_currentValue, done) => {
					const steps: SteppedSubmenuStep[] = [
						{
							key: "model",
							title: "Per-Model Thinking Level",
							description: "Select a model to configure",
							options: () => {
								const sorted = [...config.availableDefaultModels].sort((a, b) => {
									const aKey = modelSettingKey(a);
									const bKey = modelSettingKey(b);
									if (aKey === currentModelKey) return -1;
									if (bKey === currentModelKey) return 1;
									if (aKey === currentDefaultModelKey) return -1;
									if (bKey === currentDefaultModelKey) return 1;
									return a.provider.localeCompare(b.provider);
								});
								const items: SelectItem[] = sorted.map((model) => {
									const key = modelSettingKey(model);
									const override = currentModelThinkingLevels[key];
									return {
										value: key,
										label: modelItemLabel(model),
										description: override ?? undefined,
									};
								});
								if (items.length === 0) {
									items.push({
										value: "__none__",
										label: "No models available",
										description: "Log in to a provider or configure an API key first",
									});
								}
								return items;
							},
							preselect: () => currentModelKey ?? currentDefaultModelKey,
							searchable: true,
							layout: MODEL_PICKER_LAYOUT,
						},
						{
							key: "level",
							title: (ctx) => {
								const m = defaultModelByValue.get(ctx.model);
								return `Thinking Level for ${m ? modelDisplayLabel(m) : ctx.model}`;
							},
							description: "Select default thinking level for this model",
							options: (ctx) => {
								const model = defaultModelByValue.get(ctx.model);
								if (!model) return [];
								const levels = (
									model.reasoning ? getSupportedThinkingLevels(model) : ["off"]
								) as ThinkingLevel[];
								const activeLevel = currentModelThinkingLevels[ctx.model];
								const items: SelectItem[] = levels.map((level) => ({
									value: level,
									label: `${level === activeLevel ? "✓ " : "  "}${level}`,
									description: THINKING_DESCRIPTIONS[level],
								}));
								if (currentModelThinkingLevels[ctx.model] !== undefined) {
									items.push({
										value: CLEAR_OVERRIDE_VALUE,
										label: "  (clear override)",
										description: `Revert to global default (${config.thinkingLevel})`,
									});
								}
								return items;
							},
							preselect: (ctx) => currentModelThinkingLevels[ctx.model],
						},
					];

					const summary = () => modelThinkingOverridesSummary(currentModelThinkingLevels);

					return new SteppedSubmenu(
						steps,
						(selections) => {
							const model = defaultModelByValue.get(selections.model);
							if (!model) return;
							if (selections.level === CLEAR_OVERRIDE_VALUE) {
								callbacks.onModelThinkingLevelRemove(model.provider, model.id);
								delete currentModelThinkingLevels[selections.model];
							} else {
								callbacks.onModelThinkingLevelChange(
									model.provider,
									model.id,
									selections.level as ThinkingLevel,
								);
								currentModelThinkingLevels[selections.model] = selections.level as ThinkingLevel;
							}
						},
						() => {
							done(summary());
						},
						{ loop: true },
					);
				},
			},
			{
				id: "tui-mode",
				label: "TUI mode",
				description: "Interface layout; fullscreen mode is experimental",
				currentValue: config.tuiMode,
				values: ["regular", "fullscreen"],
			},
			{
				id: "fullscreen-exit-output",
				label: "Fullscreen exit output",
				description: "Print the transcript or only a session resume hint when exiting fullscreen mode",
				currentValue: config.fullscreenExitOutput,
				values: ["transcript", "resume-hint"],
			},
			{
				id: "fullscreen-scrollbar",
				label: "Fullscreen scrollbar",
				description: "Scrollbar behavior in fullscreen mode; has no effect in regular mode",
				currentValue: config.fullscreenScrollbar,
				values: ["auto", "always", "hidden"],
			},
			{
				id: "fullscreen-copy-on-select",
				label: "Fullscreen copy on select",
				description: "Automatically copy selected text in fullscreen mode; disable to copy selections with Ctrl+X",
				currentValue: config.fullscreenCopyOnSelect ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "theme",
				label: "Theme",
				description: "Color theme for the interface",
				currentValue: config.currentTheme,
				submenu: (currentValue, done) =>
					new ThemeSubmenu(currentValue, config.terminalTheme, config.availableThemes, callbacks, done),
			},
		];

		// Only show image toggle if terminal supports it
		if (supportsImages) {
			// Insert after autocompact
			items.splice(1, 0, {
				id: "show-images",
				label: "Show images",
				description: "Render images inline in terminal",
				currentValue: config.showImages ? "true" : "false",
				values: ["true", "false"],
			});
			items.splice(2, 0, {
				id: "image-width-cells",
				label: "Image width",
				description: "Preferred inline image width in terminal cells",
				currentValue: String(config.imageWidthCells),
				values: ["60", "80", "120"],
			});
		}

		// Image auto-resize toggle (always available, affects both attached and read images)
		items.splice(supportsImages ? 3 : 1, 0, {
			id: "auto-resize-images",
			label: "Auto-resize images",
			description: "Resize large images to 2000x2000 max for better model compatibility",
			currentValue: config.autoResizeImages ? "true" : "false",
			values: ["true", "false"],
		});

		// Block images toggle (always available, insert after auto-resize-images)
		const autoResizeIndex = items.findIndex((item) => item.id === "auto-resize-images");
		items.splice(autoResizeIndex + 1, 0, {
			id: "block-images",
			label: "Block images",
			description: "Prevent images from being sent to LLM providers",
			currentValue: config.blockImages ? "true" : "false",
			values: ["true", "false"],
		});

		// Skill commands toggle (insert after block-images)
		const blockImagesIndex = items.findIndex((item) => item.id === "block-images");
		items.splice(blockImagesIndex + 1, 0, {
			id: "skill-commands",
			label: "Skill commands",
			description: "Register skills as /skill:name commands",
			currentValue: config.enableSkillCommands ? "true" : "false",
			values: ["true", "false"],
		});

		// Hardware cursor toggle (insert after skill-commands)
		const skillCommandsIndex = items.findIndex((item) => item.id === "skill-commands");
		items.splice(skillCommandsIndex + 1, 0, {
			id: "show-hardware-cursor",
			label: "Show hardware cursor",
			description: "Show the terminal cursor while still positioning it for IME support",
			currentValue: config.showHardwareCursor ? "true" : "false",
			values: ["true", "false"],
		});

		// Editor padding toggle (insert after show-hardware-cursor)
		const hardwareCursorIndex = items.findIndex((item) => item.id === "show-hardware-cursor");
		items.splice(hardwareCursorIndex + 1, 0, {
			id: "editor-padding",
			label: "Editor padding",
			description: "Horizontal padding for input editor (0-3)",
			currentValue: String(config.editorPaddingX),
			values: ["0", "1", "2", "3"],
		});

		// Output padding toggle (insert after editor-padding)
		const editorPaddingIndex = items.findIndex((item) => item.id === "editor-padding");
		items.splice(editorPaddingIndex + 1, 0, {
			id: "output-padding",
			label: "Output padding",
			description: "Horizontal padding for user messages, assistant messages, and thinking",
			currentValue: String(config.outputPad),
			values: ["0", "1"],
		});

		// Autocomplete max visible toggle (insert after output-padding)
		const outputPaddingIndex = items.findIndex((item) => item.id === "output-padding");
		items.splice(outputPaddingIndex + 1, 0, {
			id: "autocomplete-max-visible",
			label: "Autocomplete max items",
			description: "Max visible items in autocomplete dropdown (3-20)",
			currentValue: String(config.autocompleteMaxVisible),
			values: ["3", "5", "7", "10", "15", "20"],
		});

		// Clear on shrink toggle (insert after autocomplete-max-visible)
		const autocompleteIndex = items.findIndex((item) => item.id === "autocomplete-max-visible");
		items.splice(autocompleteIndex + 1, 0, {
			id: "clear-on-shrink",
			label: "Clear on shrink",
			description: "Clear empty rows when content shrinks (may cause flicker)",
			currentValue: config.clearOnShrink ? "true" : "false",
			values: ["true", "false"],
		});

		// Terminal progress toggle (insert after clear-on-shrink)
		const clearOnShrinkIndex = items.findIndex((item) => item.id === "clear-on-shrink");
		items.splice(clearOnShrinkIndex + 1, 0, {
			id: "terminal-progress",
			label: "Terminal progress",
			description: "Show OSC 9;4 progress indicators in the terminal tab bar",
			currentValue: config.showTerminalProgress ? "true" : "false",
			values: ["true", "false"],
		});

		// Add borders
		this.addChild(new DynamicBorder());

		this.settingsList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "autocompact":
						callbacks.onAutoCompactChange(newValue === "true");
						break;
					case "show-images":
						callbacks.onShowImagesChange(newValue === "true");
						break;
					case "image-width-cells":
						callbacks.onImageWidthCellsChange(parseInt(newValue, 10));
						break;
					case "auto-resize-images":
						callbacks.onAutoResizeImagesChange(newValue === "true");
						break;
					case "block-images":
						callbacks.onBlockImagesChange(newValue === "true");
						break;
					case "skill-commands":
						callbacks.onEnableSkillCommandsChange(newValue === "true");
						break;
					case "steering-mode":
						callbacks.onSteeringModeChange(newValue as "all" | "one-at-a-time");
						break;
					case "follow-up-mode":
						callbacks.onFollowUpModeChange(newValue as "all" | "one-at-a-time");
						break;
					case "transport":
						callbacks.onTransportChange(newValue as Transport);
						break;
					case "http-idle-timeout": {
						const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.label === newValue);
						if (choice) {
							callbacks.onHttpIdleTimeoutMsChange(choice.timeoutMs);
						}
						break;
					}
					case "hide-thinking":
						callbacks.onHideThinkingBlockChange(newValue === "true");
						break;
					case "mermaid-rendering":
						callbacks.onMermaidRenderingModeChange(newValue as MermaidRenderingMode);
						break;
					case "cache-miss-notices":
						callbacks.onShowCacheMissNoticesChange(newValue === "true");
						break;
					case "collapse-changelog":
						callbacks.onCollapseChangelogChange(newValue === "true");
						break;
					case "quiet-startup":
						callbacks.onQuietStartupChange(newValue === "true");
						break;
					case "install-telemetry":
						callbacks.onEnableInstallTelemetryChange(newValue === "true");
						break;
					case "default-project-trust": {
						const defaultProjectTrust = DEFAULT_PROJECT_TRUST_BY_LABEL.get(newValue);
						if (defaultProjectTrust) {
							callbacks.onDefaultProjectTrustChange(defaultProjectTrust);
						}
						break;
					}
					case "double-escape-action":
						callbacks.onDoubleEscapeActionChange(newValue as "fork" | "tree");
						break;
					case "tree-filter-mode":
						callbacks.onTreeFilterModeChange(
							newValue as "default" | "no-tools" | "user-only" | "labeled-only" | "all",
						);
						break;
					case "show-hardware-cursor":
						callbacks.onShowHardwareCursorChange(newValue === "true");
						break;
					case "editor-padding":
						callbacks.onEditorPaddingXChange(parseInt(newValue, 10));
						break;
					case "output-padding":
						callbacks.onOutputPadChange(newValue === "0" ? 0 : 1);
						break;
					case "autocomplete-max-visible":
						callbacks.onAutocompleteMaxVisibleChange(parseInt(newValue, 10));
						break;
					case "clear-on-shrink":
						callbacks.onClearOnShrinkChange(newValue === "true");
						break;
					case "terminal-progress":
						callbacks.onShowTerminalProgressChange(newValue === "true");
						break;
					case "tui-mode":
						callbacks.onTuiModeChange(newValue as TuiMode);
						break;
					case "fullscreen-exit-output":
						callbacks.onFullscreenExitOutputChange(newValue as FullscreenExitOutput);
						break;
					case "fullscreen-scrollbar":
						callbacks.onFullscreenScrollbarChange(newValue as ScrollViewScrollbar);
						break;
					case "fullscreen-copy-on-select":
						callbacks.onFullscreenCopyOnSelectChange(newValue === "true");
						break;
					case "theme":
						callbacks.onThemeChange(newValue);
						break;
				}
			},
			callbacks.onCancel,
			{ enableSearch: true },
		);

		this.addChild(this.settingsList);
		this.addChild(new DynamicBorder());
	}

	getSettingsList(): SettingsList {
		return this.settingsList;
	}
}
