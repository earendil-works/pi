import { existsSync, readFileSync } from "node:fs";
import type * as OsModule from "node:os";
import type { NativeClipboard } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { copyToClipboard, readClipboardFilePaths, readClipboardText } from "../src/utils/clipboard.ts";

const mocks = vi.hoisted(() => ({
	clipboard: {
		getText: vi.fn<NativeClipboard["getText"]>(),
		getImage: vi.fn<NativeClipboard["getImage"]>(),
		getFilePaths: vi.fn<NonNullable<NativeClipboard["getFilePaths"]>>(),
		setText: vi.fn<(text: string) => Promise<void>>(),
	},
	getNativeClipboard: vi.fn<() => NativeClipboard | undefined>(),
	command:
		vi.fn<
			(
				command: string,
				args: readonly string[],
				options?: { input?: string; timeoutMs?: number },
			) => Promise<Buffer | undefined>
		>(),
	platform: vi.fn<() => NodeJS.Platform>(),
}));
vi.mock("@earendil-works/pi-tui", () => ({ getNativeClipboard: mocks.getNativeClipboard }));
vi.mock("../src/utils/clipboard-command.ts", () => ({ runClipboardCommand: mocks.command }));
vi.mock("node:os", async () => ({
	...(await vi.importActual<typeof OsModule>("node:os")),
	platform: mocks.platform,
}));

let originalWrite: typeof process.stdout.write;
let osc52Writes: string[];
beforeEach(() => {
	vi.resetAllMocks();
	for (const name of [
		"SSH_CONNECTION",
		"SSH_CLIENT",
		"MOSH_CONNECTION",
		"WAYLAND_DISPLAY",
		"DISPLAY",
		"TERMUX_VERSION",
		"WT_SESSION",
		"WSL_DISTRO_NAME",
		"WSLENV",
	])
		vi.stubEnv(name, "");
	mocks.platform.mockReturnValue("darwin");
	mocks.getNativeClipboard.mockReturnValue(mocks.clipboard);
	mocks.clipboard.getText.mockResolvedValue(null);
	mocks.clipboard.setText.mockResolvedValue();
	mocks.clipboard.getFilePaths.mockResolvedValue(null);
	mocks.command.mockResolvedValue(Buffer.alloc(0));
	osc52Writes = [];
	originalWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((...args: Parameters<typeof process.stdout.write>) => {
		const [chunk] = args;
		if (typeof chunk === "string" && chunk.startsWith("\x1b]52;c;")) {
			osc52Writes.push(chunk);
			return true;
		}
		return originalWrite(...args);
	}) as typeof process.stdout.write;
});
afterEach(() => {
	process.stdout.write = originalWrite;
	vi.unstubAllEnvs();
});

describe("readClipboardText", () => {
	test("awaits native clipboard text and catches rejected reads", async () => {
		mocks.clipboard.getText.mockResolvedValue("clipboard text");
		await expect(readClipboardText()).resolves.toBe("clipboard text");
		mocks.clipboard.getText.mockRejectedValue(new Error("clipboard unavailable"));
		await expect(readClipboardText()).resolves.toBeNull();
	});
	for (const [env, command, args, calls] of [
		["WAYLAND_DISPLAY", "wl-paste", ["--no-newline", "--type", "text"], ["wl-paste"]],
		["DISPLAY", "xclip", ["-selection", "clipboard", "-out"], ["xclip"]],
		["DISPLAY", "xsel", ["--clipboard", "--output"], ["xclip", "xsel"]],
		["TERMUX_VERSION", "termux-clipboard-get", [], ["termux-clipboard-get"]],
	] as const) {
		test.each(["clipboard text", ""])(`${command} result %j stops fallback`, async (text) => {
			// Regression test for #7248: empty Wayland content must not fall through to stale X11.
			mocks.platform.mockReturnValue("linux");
			vi.stubEnv("DISPLAY", ":0");
			vi.stubEnv(env, "1");
			mocks.command.mockImplementation(async (name) => (name === command ? Buffer.from(text) : undefined));
			await expect(readClipboardText()).resolves.toBe(text || null);
			expect(mocks.command.mock.calls.map(([name]) => name)).toEqual(calls);
			expect(mocks.command).toHaveBeenLastCalledWith(command, args, { timeoutMs: 5000 });
			expect(mocks.getNativeClipboard).not.toHaveBeenCalled();
		});
	}
	test.each(["native text", "", null, undefined])("uses native X11 after command failures: %j", async (text) => {
		mocks.platform.mockReturnValue("linux");
		vi.stubEnv("DISPLAY", ":0");
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		mocks.command.mockResolvedValue(undefined);
		mocks.clipboard.getText.mockResolvedValue(text);
		await expect(readClipboardText()).resolves.toBe(text || null);
		expect(mocks.getNativeClipboard).toHaveBeenCalledExactlyOnceWith();
		expect(mocks.command.mock.calls.map(([name]) => name)).toEqual(["wl-paste", "xclip", "xsel"]);
	});
	test("falls back to X11 tools when wl-paste is unavailable", async () => {
		mocks.platform.mockReturnValue("linux");
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		vi.stubEnv("DISPLAY", ":0");
		mocks.command.mockImplementation(async (name) => (name === "wl-paste" ? undefined : Buffer.from("X11 text")));
		await expect(readClipboardText()).resolves.toBe("X11 text");
		expect(mocks.getNativeClipboard).not.toHaveBeenCalled();
	});
});

describe("readClipboardFilePaths", () => {
	test("returns file paths from the native clipboard", async () => {
		mocks.clipboard.getFilePaths.mockResolvedValue(["/tmp/a.png", "/tmp/My Photos/b.png"]);
		await expect(readClipboardFilePaths()).resolves.toEqual(["/tmp/a.png", "/tmp/My Photos/b.png"]);
	});
	test.each([null, undefined, []])("maps %j to null", async (paths) => {
		mocks.clipboard.getFilePaths.mockResolvedValue(paths);
		await expect(readClipboardFilePaths()).resolves.toBeNull();
	});
	test("maps missing platform support to null", async () => {
		// Linux and Windows prebuilds do not export getFilePaths yet.
		mocks.getNativeClipboard.mockReturnValue({
			getText: mocks.clipboard.getText,
			getImage: mocks.clipboard.getImage,
		});
		await expect(readClipboardFilePaths()).resolves.toBeNull();
	});
	test("catches rejected reads", async () => {
		mocks.clipboard.getFilePaths.mockRejectedValue(new Error("clipboard unavailable"));
		await expect(readClipboardFilePaths()).resolves.toBeNull();
	});
});

describe("copyToClipboard", () => {
	test("local native success skips OSC 52 and commands", async () => {
		await copyToClipboard("hello");
		expect(mocks.clipboard.setText).toHaveBeenCalledWith("hello");
		expect(osc52Writes).toHaveLength(0);
		expect(mocks.command).not.toHaveBeenCalled();
	});
	test("Linux skips the native writer", async () => {
		mocks.platform.mockReturnValue("linux");
		vi.stubEnv("DISPLAY", ":0");
		await copyToClipboard("hello");
		expect(mocks.getNativeClipboard).not.toHaveBeenCalled();
		expect(mocks.command).toHaveBeenCalledWith("xclip", ["-selection", "clipboard"], {
			input: "hello",
			timeoutMs: 5000,
		});
	});
	test("waits for the native write before emitting remote OSC 52", async () => {
		vi.stubEnv("SSH_CONNECTION", "client server");
		let complete = () => {};
		mocks.clipboard.setText.mockReturnValue(
			new Promise<void>((resolve) => {
				complete = resolve;
			}),
		);
		const copy = copyToClipboard("hello");
		expect(osc52Writes).toHaveLength(0);
		complete();
		await copy;
		expect(osc52Writes).toHaveLength(1);
		expect(mocks.command).not.toHaveBeenCalled();
	});
	test("a rejected native write falls back to pbcopy", async () => {
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		await copyToClipboard("hello");
		expect(mocks.command).toHaveBeenCalledWith("pbcopy", [], { input: "hello", timeoutMs: 5000 });
		expect(osc52Writes).toHaveLength(0);
	});
	test("a read-only native clipboard uses the command writer", async () => {
		mocks.getNativeClipboard.mockReturnValue({
			getText: mocks.clipboard.getText,
			getImage: mocks.clipboard.getImage,
		});
		await copyToClipboard("hello");
		expect(mocks.command).toHaveBeenCalledOnce();
	});
	test("tries xclip and xsel after wl-copy fails", async () => {
		mocks.platform.mockReturnValue("linux");
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		vi.stubEnv("DISPLAY", ":0");
		mocks.command.mockImplementation(async (name) => (name === "xsel" ? Buffer.alloc(0) : undefined));
		await copyToClipboard("hello");
		expect(mocks.command.mock.calls.map(([name]) => name)).toEqual(["wl-copy", "xclip", "xsel"]);
		expect(osc52Writes).toHaveLength(0);
	});
	test("local Linux failure does not report an unverified OSC 52 write as success", async () => {
		// Regression test for #9618.
		mocks.platform.mockReturnValue("linux");
		vi.stubEnv("DISPLAY", ":0");
		mocks.command.mockResolvedValue(undefined);
		await expect(copyToClipboard("hello")).rejects.toThrow(
			"Clipboard unavailable: install `xclip` or `xsel`, or check X11 access",
		);
		expect(mocks.command.mock.calls.map(([name]) => name)).toEqual(["xclip", "xsel"]);
		expect(osc52Writes).toHaveLength(0);
	});
	test("display-less Linux falls back to OSC 52", async () => {
		// Regression test for #9688: containers without X11/Wayland access.
		mocks.platform.mockReturnValue("linux");
		await copyToClipboard("hello");
		expect(mocks.command).not.toHaveBeenCalled();
		expect(osc52Writes).toHaveLength(1);
	});
	test("WSL without a display writes the Windows clipboard through PowerShell", async () => {
		// Regression test for #9688: WSL with WSLg disabled.
		mocks.platform.mockReturnValue("linux");
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		let written: string | undefined;
		mocks.command.mockImplementation(async (name, args) => {
			if (name !== "wslpath") return Buffer.alloc(0);
			written = readFileSync(args[1]!, "utf8");
			return Buffer.from("\\\\wsl.localhost\\Ubuntu\\tmp\\clip.txt\n");
		});
		await copyToClipboard("héllo");
		expect(mocks.command.mock.calls.map(([name]) => name)).toEqual(["wslpath", "powershell.exe"]);
		expect(written).toBe("héllo");
		const [, wslpathArgs] = mocks.command.mock.calls[0]!;
		expect(existsSync(wslpathArgs[1]!)).toBe(false);
		const [, powershellArgs] = mocks.command.mock.calls[1]!;
		expect(powershellArgs[2]).toContain("Set-Clipboard");
		expect(powershellArgs[2]).toContain("'\\\\wsl.localhost\\Ubuntu\\tmp\\clip.txt'");
		expect(osc52Writes).toHaveLength(0);
	});
	test("WSL falls back to OSC 52 when Windows interop is unavailable", async () => {
		mocks.platform.mockReturnValue("linux");
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		mocks.command.mockResolvedValue(undefined);
		await copyToClipboard("hello");
		expect(mocks.command.mock.calls.map(([name]) => name)).toEqual(["wslpath"]);
		expect(osc52Writes).toHaveLength(1);
	});
	test("WSL in Windows Terminal prefers OSC 52 over PowerShell", async () => {
		mocks.platform.mockReturnValue("linux");
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		vi.stubEnv("WT_SESSION", "session");
		await copyToClipboard("hello");
		expect(mocks.command).not.toHaveBeenCalled();
		expect(osc52Writes).toHaveLength(1);
	});
	test("WSL in Windows Terminal emits OSC 52 once in a remote session", async () => {
		mocks.platform.mockReturnValue("linux");
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		vi.stubEnv("WT_SESSION", "session");
		vi.stubEnv("SSH_CONNECTION", "client server");
		await copyToClipboard("hello");
		expect(mocks.command).not.toHaveBeenCalled();
		expect(osc52Writes).toHaveLength(1);
	});
	test("WSL in Windows Terminal uses PowerShell for oversized OSC 52 payloads", async () => {
		mocks.platform.mockReturnValue("linux");
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		vi.stubEnv("WT_SESSION", "session");
		mocks.command.mockImplementation(async (name) =>
			name === "wslpath" ? Buffer.from("C:\\clip.txt") : Buffer.alloc(0),
		);
		await copyToClipboard("x".repeat(80_000));
		expect(mocks.command.mock.calls.map(([name]) => name)).toEqual(["wslpath", "powershell.exe"]);
		expect(osc52Writes).toHaveLength(0);
	});
	test("WSL with a display prefers the Linux clipboard tools", async () => {
		mocks.platform.mockReturnValue("linux");
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		await copyToClipboard("hello");
		expect(mocks.command.mock.calls.map(([name]) => name)).toEqual(["wl-copy"]);
		expect(osc52Writes).toHaveLength(0);
	});
	test("reports the Wayland clipboard tool instead of the X11 fallback", async () => {
		mocks.platform.mockReturnValue("linux");
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		vi.stubEnv("DISPLAY", ":0");
		mocks.command.mockResolvedValue(undefined);
		await expect(copyToClipboard("hello")).rejects.toThrow(
			"Clipboard unavailable: install `wl-clipboard` (`wl-copy`) or check Wayland access",
		);
		expect(mocks.command.mock.calls.map(([name]) => name)).toEqual(["wl-copy", "xclip", "xsel"]);
	});
	test("uses OSC 52 when native and command writes fail in a remote session", async () => {
		vi.stubEnv("SSH_CONNECTION", "client server");
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		mocks.command.mockResolvedValue(undefined);
		await copyToClipboard("hello");
		expect(osc52Writes).toHaveLength(1);
	});
	test("does not emit oversized OSC 52 payloads", async () => {
		vi.stubEnv("SSH_CONNECTION", "client server");
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		mocks.command.mockResolvedValue(undefined);
		await expect(copyToClipboard("x".repeat(80_000))).rejects.toThrow(
			"Clipboard unavailable: text exceeds the OSC 52 size limit",
		);
		expect(osc52Writes).toHaveLength(0);
	});
});
