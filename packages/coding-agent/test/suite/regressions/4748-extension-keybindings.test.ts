// Regression test for https://github.com/earendil-works/pi/issues/4748
//
// Extensions can resolve their own module instance of the pi packages, so the
// module-local keybindings manager they reach via getKeybindings()/keyText()
// never sees the host's app.* bindings and lookups come back empty. The
// ExtensionAPI exposes host-bound keybinding access instead; these tests pin
// that the API resolves the host manager at call time.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadExtensions } from "../../../src/core/extensions/loader.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";

interface CaptureState {
	api?: ExtensionAPI;
}

function capturedApi(): ExtensionAPI {
	const state = (globalThis as typeof globalThis & { __keybindingRealmTest?: CaptureState }).__keybindingRealmTest;
	if (!state?.api) throw new Error("Extension did not capture its API");
	return state.api;
}

describe("extension keybinding access (#4748)", () => {
	let root: string;
	let previousKeybindings: ReturnType<typeof getKeybindings>;

	beforeEach(async () => {
		initTheme("dark");
		previousKeybindings = getKeybindings();
		root = join(tmpdir(), `pi-keybinding-realm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const extensionPath = join(root, "capture.ts");
		writeFileSync(
			extensionPath,
			`export default function (pi) {
	(globalThis.__keybindingRealmTest ??= {}).api = pi;
}
`,
			"utf-8",
		);
		const result = await loadExtensions([extensionPath], root);
		expect(result.errors).toEqual([]);
	});

	afterEach(() => {
		setKeybindings(previousKeybindings);
		delete (globalThis as typeof globalThis & { __keybindingRealmTest?: CaptureState }).__keybindingRealmTest;
		if (existsSync(root)) rmSync(root, { recursive: true, force: true });
	});

	it("resolves app.* bindings through the host manager", () => {
		setKeybindings(new KeybindingsManager());
		const api = capturedApi();

		expect(api.keyText("app.tools.expand")).toBe("ctrl+o");
		expect(api.getKeybindings().getKeys("app.tools.expand")).toEqual(["ctrl+o"]);
	});

	it("reflects host keybinding changes at call time", () => {
		const api = capturedApi();

		setKeybindings(new KeybindingsManager());
		expect(api.keyText("app.tools.expand")).toBe("ctrl+o");

		setKeybindings(new KeybindingsManager({ "app.tools.expand": "ctrl+y" }));
		expect(api.keyText("app.tools.expand")).toBe("ctrl+y");
		expect(api.keyDisplayText("app.tools.expand")).toBe("Ctrl+Y");
	});

	it("formats themed hints with the host's bound key", () => {
		setKeybindings(new KeybindingsManager());
		const hint = capturedApi().keyHint("app.tools.expand", "to expand");

		expect(hint).toContain("ctrl+o");
		expect(hint).toContain("to expand");
	});
});
