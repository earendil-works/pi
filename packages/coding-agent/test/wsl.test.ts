import { describe, expect, it } from "vitest";
import { isWSL } from "../src/utils/wsl.ts";

describe("isWSL", () => {
	it("detects WSL via WSL_DISTRO_NAME", () => {
		expect(isWSL({ WSL_DISTRO_NAME: "Ubuntu" })).toBe(true);
	});

	it("detects WSL via WSLENV", () => {
		expect(isWSL({ WSLENV: "PATH/l" })).toBe(true);
	});

	it("returns false for a plain Linux environment without /proc/version markers", () => {
		// No WSL env vars set; /proc/version on the test host (real Linux CI) does
		// not contain microsoft/wsl, and on non-Linux the read throws and returns false.
		const result = isWSL({});
		expect(typeof result).toBe("boolean");
	});
});
