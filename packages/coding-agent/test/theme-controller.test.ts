import type { TerminalColors, TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	initTheme,
	setTerminalColorScheme,
	setTerminalColors,
	type TerminalTheme,
	theme,
} from "../src/modes/interactive/theme/theme.ts";
import { InteractiveThemeController } from "../src/modes/interactive/theme/theme-controller.ts";

const DARK: TerminalColors = { foreground: { r: 248, g: 248, b: 242 }, background: { r: 40, g: 42, b: 54 } };
const LIGHT: TerminalColors = { foreground: { r: 30, g: 30, b: 30 }, background: { r: 250, g: 250, b: 250 } };

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
	setTerminalColorScheme(undefined);
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

	it("applies the theme immediately and lets startup wait for the colors", async () => {
		const { ui, queryTerminalColors } = createUi();
		let answer: (colors: TerminalColors) => void = () => {};
		queryTerminalColors.mockReturnValue(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		const controller = createController(ui, () => SettingsManager.inMemory());
		controller.applyFromSettings();

		// Grayscale until the terminal answers.
		expect(theme.name).toBe("system");
		expect(theme.getFgAnsi("error")).toBe("\x1b[39m");

		answer(DARK);
		await controller.waitForTerminalColors();
		expect(theme.getFgAnsi("error")).toMatch(/^\x1b\[38;/);
	});

	it("falls back to palette indices, then applies colors that arrive after the timeout", async () => {
		const { ui, queryTerminalColors } = createUi();
		let lateReply: (colors: TerminalColors) => void = () => {};
		queryTerminalColors.mockImplementation(async (options) => {
			lateReply = options.onLateReply!;
			return {};
		});
		const controller = createController(ui, () => SettingsManager.inMemory());
		controller.applyFromSettings();
		await flush();
		expect(theme.getFgAnsi("error")).toBe("\x1b[38;5;1m");

		lateReply(DARK);
		expect(theme.colors.error.kind).toBe("rgb");
	});

	it("re-queries the colors on appearance changes and lets them decide", async () => {
		const { ui, queryTerminalColors, setTerminalColorSchemeNotifications, emitTerminalColorScheme } = createUi();
		queryTerminalColors.mockResolvedValue(LIGHT);
		const controller = createController(ui, () => SettingsManager.inMemory(), "light/dark");
		controller.applyFromSettings();
		expect(setTerminalColorSchemeNotifications).toHaveBeenCalledWith(true);
		await flush();
		expect(theme.name).toBe("light");

		queryTerminalColors.mockResolvedValue(DARK);
		// The report says light, but the terminal renders dark.
		emitTerminalColorScheme("light");
		await flush();
		expect(theme.name).toBe("dark");
	});

	it("uses the reported scheme for the system theme when the terminal reports no colors", async () => {
		vi.stubEnv("COLORFGBG", "");
		const { ui, emitTerminalColorScheme } = createUi();
		const controller = createController(ui, () => SettingsManager.inMemory());
		controller.applyFromSettings();
		await flush();
		expect(theme.appearance).toBe("dark");

		emitTerminalColorScheme("light");
		expect(theme.appearance).toBe("light");
		expect(controller.getTerminalTheme()).toBe("light");
	});

	it("re-renders only when the reported colors change", async () => {
		const { ui, queryTerminalColors } = createUi();
		const controller = createController(ui, () => SettingsManager.inMemory({ theme: "dark" }));
		const query = async (colors: TerminalColors) => {
			queryTerminalColors.mockResolvedValue(colors);
			controller.applyFromSettings();
			await flush();
		};

		await query(DARK);
		// A timeout keeps the known colors; erasing them would count as a change and re-render.
		await query({});
		await query(structuredClone(DARK));
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
