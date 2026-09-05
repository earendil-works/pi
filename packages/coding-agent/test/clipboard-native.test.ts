import { describe, expect, test, vi } from "vitest";
import { type ClipboardModule, loadClipboardNative } from "../src/utils/clipboard-native.ts";

type ClipboardRequire = (id: string) => unknown;

const fakeClipboard: ClipboardModule = {
	getText: async () => "",
	setText: async () => {},
	hasImage: () => true,
	getImageBinary: async () => [1, 2, 3],
};

describe("loadClipboardNative", () => {
	test("falls back to the next require root", () => {
		const primary = vi.fn<ClipboardRequire>(() => {
			throw new Error("missing from bundled root");
		});
		const fallback = vi.fn<ClipboardRequire>(() => fakeClipboard);

		expect(loadClipboardNative([primary, fallback])).toBe(fakeClipboard);
		expect(primary).toHaveBeenCalledWith("@mariozechner/clipboard");
		expect(fallback).toHaveBeenCalledWith("@mariozechner/clipboard");
	});

	test("returns null when no require root can load clipboard", () => {
		const missing = vi.fn<ClipboardRequire>(() => {
			throw new Error("missing");
		});

		expect(loadClipboardNative([missing])).toBeNull();
	});

	test("does not initialize the native clipboard on Linux", async () => {
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		if (!platformDescriptor) {
			throw new Error("process.platform descriptor is unavailable");
		}

		try {
			vi.stubEnv("DISPLAY", ":0");
			Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
			vi.resetModules();

			const linuxModule = await import("../src/utils/clipboard-native.ts");
			expect(linuxModule.clipboard).toBeNull();
		} finally {
			Object.defineProperty(process, "platform", platformDescriptor);
			vi.unstubAllEnvs();
			vi.resetModules();
		}
	});
});
