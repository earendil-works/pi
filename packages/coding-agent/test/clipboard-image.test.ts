import type { NativeClipboard } from "@earendil-works/pi-tui";
import { writeFileSync } from "fs";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { readClipboardImage } from "../src/utils/clipboard-image.ts";

const mocks = vi.hoisted(() => ({
	command: vi.fn<(command: string, args: string[], options?: unknown) => Promise<Buffer | undefined>>(),
	getImage: vi.fn<NativeClipboard["getImage"]>(),
	getNativeClipboard: vi.fn<() => NativeClipboard | undefined>(),
}));

vi.mock("../src/utils/clipboard-command.ts", () => ({ runClipboardCommand: mocks.command }));
vi.mock("@earendil-works/pi-tui", () => ({ getNativeClipboard: mocks.getNativeClipboard }));

function commandResult(stdout: Buffer, status = 0): Buffer | undefined {
	return status === 0 ? stdout : undefined;
}

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

describe("readClipboardImage", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.command.mockResolvedValue(commandResult(Buffer.alloc(0), 1));
		mocks.getImage.mockResolvedValue(png);
		mocks.getNativeClipboard.mockReturnValue({ getText: async () => null, getImage: mocks.getImage });
	});

	for (const [backend, command, env] of [
		["wayland", "wl-paste", { WAYLAND_DISPLAY: "1", DISPLAY: ":0" }],
		["x11", "xclip", { DISPLAY: ":0" }],
	] as const) {
		test.each([true, false])(`${backend}: command image present=%s stops fallback`, async (present) => {
			mocks.command.mockImplementation(async (name, args) => {
				expect(name).toBe(command);
				const listing = args.includes("--list-types") || args.includes("TARGETS");
				return commandResult(listing ? Buffer.from(present ? "text/plain\nimage/png\n" : "text/plain\n") : png);
			});
			expect(await readClipboardImage({ platform: "linux", env })).toEqual(
				present ? { bytes: png, mimeType: "image/png" } : null,
			);
			expect(mocks.command).toHaveBeenCalledTimes(present ? 2 : 1);
			expect(mocks.getNativeClipboard).not.toHaveBeenCalled();
		});
	}

	test.each([png, null, new Uint8Array()])("native X11 result %j stops fallback", async (bytes) => {
		mocks.getImage.mockResolvedValue(bytes);
		expect(await readClipboardImage({ platform: "linux", env: { DISPLAY: ":0" } })).toEqual(
			bytes?.length ? { bytes, mimeType: "image/png" } : null,
		);
		expect(mocks.getNativeClipboard).toHaveBeenCalledExactlyOnceWith();
		expect(mocks.getImage).toHaveBeenCalledOnce();
		expect(mocks.command.mock.calls.map(([name]) => name)).toEqual(Array<string>(5).fill("xclip"));
	});
	test.each(["missing module", "unavailable display"])("Wayland: falls back to X11 after %s", async (failure) => {
		if (failure === "missing module") mocks.getNativeClipboard.mockReturnValue(undefined);
		else mocks.getImage.mockResolvedValue(undefined);
		mocks.command.mockImplementation(async (command, args) => {
			if (command === "wl-paste") return commandResult(Buffer.alloc(0), 1);
			return commandResult(args.includes("TARGETS") ? Buffer.from("image/png\n") : Buffer.from(png));
		});
		expect(await readClipboardImage({ platform: "linux", env: { WAYLAND_DISPLAY: "1" } })).toEqual({
			bytes: png,
			mimeType: "image/png",
		});
		expect(mocks.getNativeClipboard).not.toHaveBeenCalled();
	});

	test("WSL: tries PowerShell before a broken native X11 bridge", async () => {
		mocks.getImage.mockRejectedValue(new Error("Broken X11 bridge"));
		let tmpFile: string | undefined;
		mocks.command.mockImplementation(async (command, args, options) => {
			if (command === "wl-paste" || command === "xclip") return undefined;
			if (command === "wslpath") {
				tmpFile = args[1];
				return commandResult(Buffer.from("C:\\Users\\O'Hare\\clip.png\n"));
			}
			if (command === "powershell.exe") {
				const spawnOptions = options as { env?: NodeJS.ProcessEnv };
				expect(spawnOptions.env?.PI_WSL_CLIPBOARD_IMAGE_PATH).toBeUndefined();
				expect(args[2]).toContain("$path = 'C:\\Users\\O''Hare\\clip.png'");
				if (!tmpFile) throw new Error("wslpath should be called before powershell.exe");
				writeFileSync(tmpFile, png);
				return commandResult(Buffer.from("ok\n"));
			}
			throw new Error(`Unexpected command: ${command}`);
		});
		expect(await readClipboardImage({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } })).toEqual({
			bytes: new Uint8Array(png),
			mimeType: "image/png",
		});
		expect(mocks.getNativeClipboard).not.toHaveBeenCalled();
	});

	for (const platform of ["darwin", "win32"] as const) {
		test.each([png, null, new Uint8Array(), undefined])(`${platform}: reads native image %j once`, async (bytes) => {
			mocks.getImage.mockResolvedValue(bytes);
			expect(await readClipboardImage({ platform, env: {} })).toEqual(
				bytes?.length ? { bytes, mimeType: "image/png" } : null,
			);
			expect(mocks.getImage).toHaveBeenCalledOnce();
			expect(mocks.command).not.toHaveBeenCalled();
		});
	}

	test("returns null without a native helper", async () => {
		mocks.getNativeClipboard.mockReturnValue(undefined);
		expect(await readClipboardImage({ platform: "win32", env: {} })).toBeNull();
		expect(mocks.getImage).not.toHaveBeenCalled();
	});

	test.each(["linux", "win32"] as const)(
		"%s: propagates native transfer errors without fallback",
		async (platform) => {
			const error = new Error("Native clipboard operation failed");
			mocks.getImage.mockImplementation(async () => {
				throw error;
			});
			await expect(readClipboardImage({ platform, env: { WAYLAND_DISPLAY: "1", DISPLAY: ":0" } })).rejects.toBe(
				error,
			);
			expect(mocks.command.mock.calls.map(([name]) => name)).toEqual(
				platform === "linux" ? ["wl-paste", ...Array<string>(5).fill("xclip")] : [],
			);
		},
	);

	test("Termux does not read image clipboards", async () => {
		expect(await readClipboardImage({ platform: "linux", env: { TERMUX_VERSION: "0.119" } })).toBeNull();
		expect(mocks.getNativeClipboard).not.toHaveBeenCalled();
		expect(mocks.command).not.toHaveBeenCalled();
	});
});
