import { beforeEach, describe, expect, it, vi } from "vitest";
import { KEYBINDINGS, useWindowsKeybindings } from "../src/core/keybindings.ts";

// WSL detection itself is covered by wsl.test.ts; here it is stubbed so the results do not depend on the host.
const mocks = vi.hoisted(() => ({ isWSL: vi.fn<(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv) => boolean>() }));
vi.mock("../src/utils/wsl.ts", () => ({ isWSL: mocks.isWSL }));

describe("Windows keybinding defaults", () => {
	beforeEach(() => {
		mocks.isWSL.mockReset();
		mocks.isWSL.mockReturnValue(false);
	});

	it("uses Windows keybindings on native Windows", () => {
		expect(useWindowsKeybindings("win32", {})).toBe(true);
	});

	it("uses Windows keybindings in WSL, detected by the shared WSL check", () => {
		mocks.isWSL.mockReturnValue(true);
		const env = { WSL_DISTRO_NAME: "Ubuntu" };
		expect(useWindowsKeybindings("linux", env)).toBe(true);
		expect(mocks.isWSL).toHaveBeenCalledWith("linux", env);
	});

	it("does not use Windows keybindings from WT_SESSION alone", () => {
		expect(useWindowsKeybindings("linux", { WT_SESSION: "session" })).toBe(false);
	});

	it("keeps non-Windows defaults on other platforms", () => {
		expect(useWindowsKeybindings("linux", {})).toBe(false);
		expect(useWindowsKeybindings("darwin", {})).toBe(false);
	});

	it("keeps ctrl+v as a paste key on WSL", async () => {
		if (process.platform !== "linux") return;
		mocks.isWSL.mockReturnValue(true);
		vi.resetModules();
		try {
			const { KEYBINDINGS: wslKeybindings } = await import("../src/core/keybindings.ts");
			expect(wslKeybindings["app.clipboard.pasteImage"].defaultKeys).toEqual(["alt+v", "ctrl+v"]);
		} finally {
			vi.resetModules();
		}
	});

	it("applies the detected defaults consistently", () => {
		const windowsKeybindings = useWindowsKeybindings();
		const nativeWindows = process.platform === "win32";

		expect(KEYBINDINGS["app.clipboard.pasteImage"].defaultKeys).toEqual(
			windowsKeybindings ? ["alt+v", "ctrl+v"] : "ctrl+v",
		);
		expect(KEYBINDINGS["tui.altScreen.search"].defaultKeys).toBe(windowsKeybindings ? "ctrl+f" : "ctrl+shift+f");
		expect(KEYBINDINGS["app.message.followUp"].defaultKeys).toBe(windowsKeybindings ? "ctrl+q" : "alt+enter");
		expect(KEYBINDINGS["app.model.cycleBackward"].defaultKeys).toBe(windowsKeybindings ? "alt+p" : "shift+ctrl+p");
		expect(KEYBINDINGS["tui.editor.undo"].defaultKeys).toBe(
			nativeWindows ? "ctrl+z" : windowsKeybindings ? "alt+z" : "ctrl+-",
		);
		expect(KEYBINDINGS["tui.altScreen.previousPrompt"].defaultKeys).toEqual(
			windowsKeybindings ? "ctrl+up" : ["ctrl+shift+up", "ctrl+up"],
		);
		expect(KEYBINDINGS["tui.altScreen.nextPrompt"].defaultKeys).toEqual(
			windowsKeybindings ? "ctrl+down" : ["ctrl+shift+down", "ctrl+down"],
		);
		expect(KEYBINDINGS["app.message.dequeue"].defaultKeys).toBe(windowsKeybindings ? "alt+q" : "alt+up");
	});
});
