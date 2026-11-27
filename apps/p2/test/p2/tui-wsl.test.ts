import assert from "node:assert/strict";
import { test } from "node:test";
import { launcherCapabilities } from "../../src/hosts/tui-local-preferences.ts";
import { isWSL } from "../../src/hosts/tui-wsl.ts";

// tui-wsl.ts copies coding-agent's utils/wsl.ts; its /proc/version fallback is covered by coding-agent's wsl.test.ts.
test("isWSL: any WSL variable marks Linux as WSL", () => {
	for (const env of [
		{ WSL_DISTRO_NAME: "Ubuntu" },
		{ WSL_INTEROP: "/run/WSL/123_interop" },
		{ WSLENV: "WT_SESSION/u" },
	])
		assert.equal(isWSL("linux", env), true, JSON.stringify(env));
});

test("isWSL: other platforms are never WSL, even with WSL variables set", () => {
	assert.equal(isWSL("win32", { WSLENV: "WT_SESSION/u" }), false);
	assert.equal(isWSL("darwin", { WSL_DISTRO_NAME: "Ubuntu" }), false);
});

test("launcherCapabilities: Windows keys on Windows and WSL only", () => {
	assert.equal(launcherCapabilities({}, "win32").windowsKeys, true);
	assert.equal(launcherCapabilities({ WSLENV: "WT_SESSION/u" }, "linux").windowsKeys, true);
	assert.equal(launcherCapabilities({ WSL_DISTRO_NAME: "Ubuntu" }, "darwin").windowsKeys, false);
});
