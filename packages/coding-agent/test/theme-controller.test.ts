import type { TerminalColors, TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { initTheme, setTerminalColors, type TerminalTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { InteractiveThemeController } from "../src/modes/interactive/theme/theme-controller.ts";

const PALETTE = [
	"#282a36",
	"#ff5555",
	"#50fa7b",
	"#f1fa8c",
	"#bd93f9",
	"#ff79c6",
	"#8be9fd",
	"#f8f8f2",
	"#6272a4",
	"#ff6e6e",
	"#69ff94",
	"#ffffa5",
	"#d6acff",
	"#ff92df",
	"#a4ffff",
	"#ffffff",
].map((hex) => ({
	r: Number.parseInt(hex.slice(1, 3), 16),
	g: Number.parseInt(hex.slice(3, 5), 16),
	b: Number.parseInt(hex.slice(5, 7), 16),
}));

const DARK_COLORS: TerminalColors = {
	foreground: { r: 248, g: 248, b: 242 },
	background: { r: 40, g: 42, b: 54 },
	palette: PALETTE,
};

const LIGHT_COLORS: TerminalColors = {
	foreground: { r: 30, g: 30, b: 30 },
	background: { r: 250, g: 250, b: 250 },
	palette: PALETTE,
};

type ColorQueryOptions = { timeoutMs: number; onLateReply?: (colors: TerminalColors) => void };

function createUi() {
	const queryTerminalColors = vi.fn(async (_options: ColorQueryOptions): Promise<TerminalColors> => ({}));
	const setTerminalColorSchemeNotifications = vi.fn();
	let terminalColorSchemeListener: ((terminalTheme: TerminalTheme) => void) | undefined;
	const unsubscribeTerminalColorScheme = vi.fn();
	const ui = {
		invalidate: vi.fn(),
		requestRender: vi.fn(),
		setTerminalColorSchemeNotifications,
		onTerminalColorSchemeChange: vi.fn((listener: (terminalTheme: TerminalTheme) => void) => {
			terminalColorSchemeListener = listener;
			return unsubscribeTerminalColorScheme;
		}),
		queryTerminalColors,
	} as unknown as TUI;
	return {
		ui,
		queryTerminalColors,
		setTerminalColorSchemeNotifications,
		unsubscribeTerminalColorScheme,
		emitTerminalColorScheme: (terminalTheme: TerminalTheme) => terminalColorSchemeListener?.(terminalTheme),
	};
}

function createController(ui: TUI, getSettingsManager: () => SettingsManager, initialThemeSetting?: string) {
	return new InteractiveThemeController(ui, {
		getSettingsManager,
		showError: vi.fn(),
		onChanged: vi.fn(),
		initialThemeSetting,
	});
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
	setTerminalColors({});
	initTheme("dark");
	vi.unstubAllEnvs();
});

describe("InteractiveThemeController", () => {
	it("uses the initial theme without persisting it", async () => {
		const { ui, queryTerminalColors } = createUi();
		const manager = SettingsManager.inMemory({ theme: "dark" });
		const setTheme = vi.spyOn(manager, "setTheme");
		const flushSettings = vi.spyOn(manager, "flush");
		const controller = createController(ui, () => manager, "light");

		expect(theme.name).toBe("light");
		expect(controller.getThemeSelection()).toBe("light");
		controller.applyFromSettings();
		await flush();

		expect(queryTerminalColors).toHaveBeenCalledOnce();
		expect(setTheme).not.toHaveBeenCalled();
		expect(flushSettings).not.toHaveBeenCalled();
	});

	it("never waits for the terminal to answer", () => {
		const { ui, queryTerminalColors } = createUi();
		queryTerminalColors.mockReturnValue(new Promise<TerminalColors>(() => {}));
		const controller = createController(ui, () => SettingsManager.inMemory({ theme: "light" }));

		controller.applyFromSettings();

		expect(theme.name).toBe("light");
	});

	it("lets startup wait for the terminal colors", async () => {
		const { ui, queryTerminalColors } = createUi();
		let answer: ((colors: TerminalColors) => void) | undefined;
		queryTerminalColors.mockReturnValue(
			new Promise<TerminalColors>((resolve) => {
				answer = resolve;
			}),
		);
		const controller = createController(ui, () => SettingsManager.inMemory());
		controller.applyFromSettings();
		let waited = false;
		const wait = controller.waitForTerminalColors().then(() => {
			waited = true;
		});
		await flush();
		expect(waited).toBe(false);

		answer?.(DARK_COLORS);
		await wait;
		expect(theme.getFgAnsi("error")).not.toBe("\x1b[39m");
	});

	it("resolves a theme pair from the terminal colors and follows appearance changes", async () => {
		vi.stubEnv("COLORFGBG", "15;0");
		const { ui, queryTerminalColors, setTerminalColorSchemeNotifications, emitTerminalColorScheme } = createUi();
		queryTerminalColors.mockResolvedValue(LIGHT_COLORS);
		const controller = createController(ui, () => SettingsManager.inMemory(), "light/dark");

		// COLORFGBG says dark until the terminal reports its colors.
		expect(theme.name).toBe("dark");
		controller.applyFromSettings();
		expect(setTerminalColorSchemeNotifications).toHaveBeenCalledWith(true);
		await flush();
		expect(theme.name).toBe("light");

		// A notification only triggers a new query; the reported colors decide the appearance.
		queryTerminalColors.mockResolvedValue(DARK_COLORS);
		emitTerminalColorScheme("light");
		await flush();
		expect(theme.name).toBe("dark");
	});

	it("uses the reported scheme for theme pairs when the terminal reports no colors", async () => {
		vi.stubEnv("COLORFGBG", "");
		const { ui, emitTerminalColorScheme } = createUi();
		const controller = createController(ui, () => SettingsManager.inMemory(), "light/dark");
		controller.applyFromSettings();
		await flush();
		expect(theme.name).toBe("dark");

		emitTerminalColorScheme("light");
		expect(theme.name).toBe("light");
	});

	it("uses the system theme without a setting and does not persist anything", async () => {
		const { ui, queryTerminalColors, setTerminalColorSchemeNotifications } = createUi();
		queryTerminalColors.mockResolvedValue(DARK_COLORS);
		const manager = SettingsManager.inMemory();
		const setTheme = vi.spyOn(manager, "setTheme");
		const controller = createController(ui, () => manager);

		// Grayscale until the terminal reports its colors.
		expect(theme.name).toBe("system");
		expect(theme.getFgAnsi("error")).toBe("\x1b[39m");

		controller.applyFromSettings();
		await flush();

		expect(theme.name).toBe("system");
		expect(theme.getFgAnsi("text")).toBe("\x1b[39m");
		expect(theme.getFgAnsi("error")).toMatch(/^\x1b\[38;/);
		expect(controller.getTerminalTheme()).toBe("dark");
		expect(setTerminalColorSchemeNotifications).toHaveBeenCalledWith(true);
		expect(setTheme).not.toHaveBeenCalled();
	});

	it("falls back to ANSI palette indices, then applies colors that arrive after the timeout", async () => {
		const { ui, queryTerminalColors } = createUi();
		let lateReply: ((colors: TerminalColors) => void) | undefined;
		queryTerminalColors.mockImplementation(async (options: ColorQueryOptions) => {
			lateReply = options.onLateReply;
			return {};
		});
		const controller = createController(ui, () => SettingsManager.inMemory({ theme: "system" }));
		controller.applyFromSettings();
		await flush();

		expect(theme.getFgAnsi("error")).toBe("\x1b[38;5;1m");
		expect(theme.getFgAnsi("muted")).toBe("\x1b[39m\x1b[2m");
		expect(theme.getBgAnsi("userMessageBg")).toBe("\x1b[49m");

		lateReply?.(DARK_COLORS);
		expect(theme.colors.error.kind).toBe("rgb");
		expect(theme.getFgAnsi("error")).not.toBe("\x1b[38;5;1m");
		expect(theme.getBgAnsi("userMessageBg")).not.toBe("\x1b[49m");
	});

	it("regenerates the system theme when the terminal appearance changes", async () => {
		const { ui, queryTerminalColors, emitTerminalColorScheme } = createUi();
		queryTerminalColors.mockResolvedValue(DARK_COLORS);
		const controller = createController(ui, () => SettingsManager.inMemory());
		controller.applyFromSettings();
		await flush();
		const darkText = theme.colors.text;
		expect(theme.appearance).toBe("dark");

		queryTerminalColors.mockResolvedValue(LIGHT_COLORS);
		emitTerminalColorScheme("light");
		await flush();

		expect(theme.name).toBe("system");
		expect(theme.appearance).toBe("light");
		expect(theme.colors.text).not.toEqual(darkText);
	});

	it("re-renders only when the reported colors change", async () => {
		const { ui, queryTerminalColors } = createUi();
		const controller = createController(ui, () => SettingsManager.inMemory({ theme: "dark" }));
		const query = async (colors: TerminalColors) => {
			queryTerminalColors.mockResolvedValue(colors);
			controller.applyFromSettings();
			await flush();
		};

		await query(DARK_COLORS);
		// A timeout keeps the known colors; erasing them would count as a change and re-render.
		await query({});
		await query({ ...DARK_COLORS, palette: [...PALETTE] });
		expect(ui.requestRender).toHaveBeenCalledOnce();
	});

	it("disables terminal appearance updates when disposed", async () => {
		const { ui, setTerminalColorSchemeNotifications, unsubscribeTerminalColorScheme } = createUi();
		const controller = createController(ui, () => SettingsManager.inMemory({ theme: "light/dark" }));
		controller.applyFromSettings();
		await flush();

		controller.dispose();

		expect(setTerminalColorSchemeNotifications).toHaveBeenLastCalledWith(false);
		expect(unsubscribeTerminalColorScheme).toHaveBeenCalledOnce();
	});

	it("lets an explicit selection replace the initial theme", async () => {
		const { ui } = createUi();
		const firstManager = SettingsManager.inMemory({ theme: "dark" });
		const secondManager = SettingsManager.inMemory({ theme: "light" });
		let manager = firstManager;
		const controller = createController(ui, () => manager, "light");
		controller.applyFromSettings();

		expect(controller.setThemeName("dark")).toEqual({ success: true });
		manager = secondManager;
		controller.applyFromSettings();
		await flush();

		expect(controller.getThemeSelection()).toBe("dark");
		expect(theme.name).toBe("dark");
	});

	it("reloads theme settings when no initial theme was supplied", async () => {
		const { ui } = createUi();
		const firstManager = SettingsManager.inMemory({ theme: "dark" });
		const secondManager = SettingsManager.inMemory({ theme: "light" });
		let manager = firstManager;
		const controller = createController(ui, () => manager);
		controller.applyFromSettings();

		firstManager.applyOverrides({ theme: "light" });
		controller.applyFromSettings();
		expect(theme.name).toBe("light");

		secondManager.applyOverrides({ theme: "dark" });
		manager = secondManager;
		controller.applyFromSettings();
		expect(theme.name).toBe("dark");
	});
});
