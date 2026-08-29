import {
	Editor,
	type EditorOptions,
	type EditorState,
	getKeybindings,
	ProcessTerminal,
	setCapabilityOverrides,
	setKeybindings,
	type Terminal,
	type TUI,
	TuiMainScreen,
	type TuiStopOptions,
} from "@earendil-works/pi-tui";
import { existsSync } from "fs";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, getAgentDir, getSettingsPath, PACKAGE_NAME } from "../config.ts";
import { areExperimentalFeaturesEnabled } from "../core/experimental.ts";
import { KeybindingsManager } from "../core/keybindings.ts";
import { DefaultPackageManager, type ResolvedResource } from "../core/package-manager.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { ExtensionInputComponent } from "../modes/interactive/components/extension-input.ts";
import { ExtensionSelectorComponent } from "../modes/interactive/components/extension-selector.ts";
import {
	FirstTimeSetupComponent,
	type FirstTimeSetupResult,
} from "../modes/interactive/components/first-time-setup.ts";
import {
	detectTerminalBackgroundFromEnv,
	detectTerminalThemeForAuto,
	getEditorTheme,
	initTheme,
	loadThemeFromPath,
	parseAutoThemeSetting,
	resolveThemeSetting,
	setRegisteredThemes,
	setTheme,
	type Theme,
} from "../modes/interactive/theme/theme.ts";

const OFFICIAL_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const OFFICIAL_APP_NAME = "pi";
const OFFICIAL_CONFIG_DIR_NAME = ".pi";

export type StartupComposerCancelReason = "interrupt" | "clear" | "exit";

export interface StartupComposerOptions extends EditorOptions {
	onCancel?: (reason: StartupComposerCancelReason) => void;
}

/** UI handoff used while a startup dialog temporarily owns the terminal. */
export interface StartupComposerHandoff {
	readonly ui: TUI;
	pause(): void;
	resume(): void;
	isCancelled?(): boolean;
	isRunning?(): boolean;
}

export interface StartupComposerSession extends StartupComposerHandoff {
	readonly composer: StartupComposer;
	readonly terminal: Terminal;
	getState(): EditorState;
	stop(options?: TuiStopOptions): void;
	isRunning(): boolean;
}

/**
 * The runtime-independent editor shown while the session runtime is loading.
 * It deliberately forwards only editing input to Editor; runtime actions are
 * handled after the normal InteractiveMode has taken over.
 */
function captureEditorState(editor: Editor): EditorState {
	return (
		editor.getState?.() ?? {
			text: editor.getText(),
			cursor: editor.getCursor(),
			pasteRegistry: new Map(),
			pasteCounter: 0,
			pasteBuffer: "",
			isInPaste: false,
		}
	);
}

export class StartupComposer extends Editor {
	private readonly cancelCallback?: (reason: StartupComposerCancelReason) => void;

	constructor(tui: TUI, options: StartupComposerOptions = {}) {
		super(tui, getEditorTheme(), options);
		this.cancelCallback = options.onCancel;
	}

	override handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "app.interrupt")) {
			this.cancelCallback?.("interrupt");
			return;
		}
		if (keybindings.matches(data, "app.clear") || keybindings.matches(data, "tui.input.copy")) {
			this.cancelCallback?.("clear");
			return;
		}
		if (keybindings.matches(data, "app.exit") && this.getText().length === 0) {
			this.cancelCallback?.("exit");
			return;
		}
		if (keybindings.matches(data, "tui.input.submit")) {
			// Submission is intentionally disabled until the normal editor is ready.
			return;
		}

		// No autocomplete provider or app handlers are installed here. Slash
		// input and runtime shortcuts therefore remain plain editable text.
		super.handleInput(data);
	}
}

export interface StartupComposerCreateOptions extends StartupComposerOptions {
	terminal?: Terminal;
}

export interface StartupTuiOptions {
	terminal?: Terminal;
	ui?: TUI;
	handoff?: StartupComposerHandoff;
}

interface DistributionMetadata {
	packageName: string;
	appName: string;
	configDirName: string;
}

function isOfficialDistribution({ packageName, appName, configDirName }: DistributionMetadata): boolean {
	return (
		packageName === OFFICIAL_PACKAGE_NAME &&
		appName === OFFICIAL_APP_NAME &&
		configDirName === OFFICIAL_CONFIG_DIR_NAME
	);
}

function loadThemes(resources: ResolvedResource[]): Theme[] {
	const themes: Theme[] = [];
	const seen = new Set<string>();
	for (const resource of resources) {
		if (!resource.enabled) continue;
		try {
			const loadedTheme = loadThemeFromPath(resource.path);
			if (loadedTheme.name) {
				if (seen.has(loadedTheme.name)) continue;
				seen.add(loadedTheme.name);
			}
			themes.push(loadedTheme);
		} catch {
			// Startup prompts should not fail because a theme is broken. The normal
			// resource loader reports theme diagnostics later in startup.
		}
	}
	return themes;
}

async function loadStartupThemes(settingsManager: SettingsManager): Promise<Theme[]> {
	const globalSettingsManager = SettingsManager.inMemory(settingsManager.getGlobalSettings(), {
		projectTrusted: false,
	});
	const packageManager = new DefaultPackageManager({
		cwd: process.cwd(),
		agentDir: getAgentDir(),
		settingsManager: globalSettingsManager,
	});
	const resolvedPaths = await packageManager.resolve(async () => "skip");
	return loadThemes(resolvedPaths.themes);
}

function createConfiguredStartupTui(settingsManager: SettingsManager, terminal: Terminal): TUI {
	setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
	const terminalTheme = detectTerminalBackgroundFromEnv().theme;
	initTheme(resolveThemeSetting(settingsManager.getThemeSetting(), terminalTheme) ?? terminalTheme);
	setKeybindings(KeybindingsManager.create());
	const ui: TUI = new TuiMainScreen(terminal, settingsManager.getShowHardwareCursor(), getAgentDir());
	ui.setClearOnShrink(settingsManager.getClearOnShrink());
	return ui;
}

export async function createStartupTui(
	settingsManager: SettingsManager,
	terminal: Terminal = new ProcessTerminal(),
): Promise<TUI> {
	setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
	setRegisteredThemes(await loadStartupThemes(settingsManager));
	return createConfiguredStartupTui(settingsManager, terminal);
}

export function startStartupTui(ui: TUI, settingsManager: SettingsManager, isActive: () => boolean = () => true): void {
	ui.start();
	void applyDetectedStartupTheme(ui, settingsManager, isActive);
}

async function applyDetectedStartupTheme(
	ui: TUI,
	settingsManager: SettingsManager,
	isActive: () => boolean,
): Promise<void> {
	const themeSetting = settingsManager.getThemeSetting();
	if (themeSetting && !parseAutoThemeSetting(themeSetting)) return;

	const terminalTheme = await detectTerminalThemeForAuto({ ui, timeoutMs: 100 });
	if (!isActive()) return;
	setTheme(resolveThemeSetting(themeSetting, terminalTheme) ?? terminalTheme);
	ui.invalidate();
	ui.requestRender();
}

async function clearStartupTui(ui: TUI): Promise<void> {
	ui.clear();
	ui.requestRender();
	await new Promise((resolve) => setTimeout(resolve, 25));
}

/**
 * Start the runtime-independent composer on a terminal immediately.
 *
 * The returned session owns the renderer until the runtime is ready. Dialogs
 * can pause it and reuse the same renderer and terminal through the handoff
 * methods, keeping the draft out of selector/input components.
 */
export function createStartupComposer(
	settingsManager: SettingsManager,
	options: StartupComposerCreateOptions = {},
): StartupComposerSession {
	const { terminal: configuredTerminal, ...composerOptions } = options;
	const terminal = configuredTerminal ?? new ProcessTerminal();
	const ui = createConfiguredStartupTui(settingsManager, terminal);
	let running = false;
	let paused = false;
	let stopped = false;
	let cancelled = false;
	let pausedState: EditorState | undefined;

	const composer = new StartupComposer(ui, {
		...composerOptions,
		onCancel: (reason) => {
			cancelled = true;
			composerOptions.onCancel?.(reason);
		},
	});

	ui.addChild(composer);
	ui.setFocus(composer);
	running = true;
	startStartupTui(ui, settingsManager, () => running && !stopped);
	ui.renderNow();

	const session: StartupComposerSession = {
		ui,
		composer,
		terminal,
		getState: () => captureEditorState(composer),
		pause: () => {
			if (!running || paused || stopped) return;
			pausedState = captureEditorState(composer);
			ui.removeChild(composer);
			ui.setFocus(null);
			ui.stop({ preserveScreen: true });
			running = false;
			paused = true;
		},
		resume: () => {
			if (!paused || stopped) return;
			if (pausedState) {
				composer.setState?.(pausedState);
			}
			ui.clear();
			ui.addChild(composer);
			ui.setFocus(composer);
			running = true;
			paused = false;
			startStartupTui(ui, settingsManager, () => running && !stopped);
			ui.renderNow(true);
			pausedState = undefined;
		},
		stop: (stopOptions) => {
			if (running || paused) {
				ui.removeChild(composer);
				ui.setFocus(null);
				ui.stop(stopOptions);
				running = false;
			}
			stopped = true;
			paused = false;
			pausedState = undefined;
			if (stopOptions?.preserveScreen !== true) {
				terminal.clearScreen();
			}
		},
		isRunning: () => running,
		isCancelled: () => cancelled,
	};

	return session;
}

/**
 * First-time setup runs when all of these hold:
 * - this is the official Pi distribution (not a fork/rebrand)
 * - experimental features are enabled (PI_EXPERIMENTAL=1)
 * - the default agent directory is used (no custom agent dir override)
 * - setup was not completed before (settings.json does not exist)
 */
export function shouldRunFirstTimeSetup(settingsPath: string = getSettingsPath()): boolean {
	if (
		!isOfficialDistribution({
			packageName: PACKAGE_NAME,
			appName: APP_NAME,
			configDirName: CONFIG_DIR_NAME,
		})
	) {
		return false;
	}
	if (!areExperimentalFeaturesEnabled()) {
		return false;
	}
	if (process.env[ENV_AGENT_DIR]) {
		return false;
	}
	return !existsSync(settingsPath);
}

export async function showStartupSelector<T>(
	settingsManager: SettingsManager,
	title: string,
	options: Array<{ label: string; value: T }>,
	startupOptions: StartupTuiOptions = {},
): Promise<T | undefined> {
	if (startupOptions.handoff?.isCancelled?.()) {
		return undefined;
	}

	const handoff = startupOptions.handoff;
	handoff?.pause();
	let ui: TUI;
	try {
		ui = startupOptions.ui ?? handoff?.ui ?? (await createStartupTui(settingsManager, startupOptions.terminal));
	} catch (error) {
		handoff?.resume();
		throw error;
	}

	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: T | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			ui.setFocus(null);
			ui.removeChild(selector);
			selector.dispose();
			await clearStartupTui(ui);
			ui.stop();
			handoff?.resume();
			resolve(result);
		};

		const selector = new ExtensionSelectorComponent(
			title,
			options.map((option) => option.label),
			(option) => void finish(options.find((entry) => entry.label === option)?.value),
			() => void finish(undefined),
			{ tui: ui },
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		startStartupTui(ui, settingsManager, () => handoff?.isRunning?.() ?? true);
	});
}

/** Show the first-time setup dialog and persist the result */
export async function showFirstTimeSetup(settingsManager: SettingsManager): Promise<void> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: FirstTimeSetupResult | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			if (result) {
				settingsManager.setTheme(result.theme);
				settingsManager.setEnableAnalytics(result.shareAnalytics);
				await settingsManager.flush();
			}
			await clearStartupTui(ui);
			ui.stop();
			resolve();
		};

		const showSetup = async () => {
			ui.start();
			const detectedTheme = await detectTerminalThemeForAuto({ ui, timeoutMs: 100 });
			setTheme(detectedTheme);
			const component = new FirstTimeSetupComponent({
				detectedTheme,
				onThemePreview: (themeName) => {
					setTheme(themeName);
					ui.requestRender();
				},
				onSubmit: (result) => void finish(result),
				onCancel: () => void finish(undefined),
			});
			ui.addChild(component);
			ui.setFocus(component);
			ui.requestRender();
		};

		void showSetup();
	});
}

export async function showStartupInput(
	settingsManager: SettingsManager,
	title: string,
	placeholder?: string,
	startupOptions: StartupTuiOptions = {},
): Promise<string | undefined> {
	if (startupOptions.handoff?.isCancelled?.()) {
		return undefined;
	}

	const handoff = startupOptions.handoff;
	handoff?.pause();
	let ui: TUI;
	try {
		ui = startupOptions.ui ?? handoff?.ui ?? (await createStartupTui(settingsManager, startupOptions.terminal));
	} catch (error) {
		handoff?.resume();
		throw error;
	}

	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			input.dispose();
			ui.setFocus(null);
			ui.removeChild(input);
			await clearStartupTui(ui);
			ui.stop();
			handoff?.resume();
			resolve(result);
		};

		const input = new ExtensionInputComponent(
			title,
			placeholder,
			(value) => void finish(value),
			() => void finish(undefined),
			{
				tui: ui,
			},
		);
		ui.addChild(input);
		ui.setFocus(input);
		startStartupTui(ui, settingsManager, () => handoff?.isRunning?.() ?? true);
	});
}
