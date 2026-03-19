import * as child_process from "child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({
	spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock("@mariozechner/pi-ai/oauth", () => ({
	getOAuthProviders: () => [{ id: "test", name: "Test Provider" }],
}));

vi.mock("@mariozechner/pi-tui", () => ({
	Container: class {
		addChild() {}
		clear() {}
	},
	Text: class {},
	Spacer: class {},
	Input: class {
		onSubmit = null;
		onEscape = null;
		focused = false;
		getValue() {
			return "";
		}
		setValue() {}
		handleInput() {}
	},
	getEditorKeybindings: () => ({ matches: () => false }),
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({
	theme: { fg: (_style: string, text: string) => text },
}));

vi.mock("../src/modes/interactive/components/dynamic-border.js", () => ({
	DynamicBorder: class {},
}));

vi.mock("../src/modes/interactive/components/keybinding-hints.js", () => ({
	keyHint: () => "",
}));

describe("LoginDialogComponent URL opening", () => {
	const originalPlatform = process.platform;

	function setPlatform(platform: string) {
		Object.defineProperty(process, "platform", { value: platform, writable: true });
	}

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
		vi.clearAllMocks();
	});

	async function createDialog() {
		const { LoginDialogComponent } = await import("../src/modes/interactive/components/login-dialog.js");
		const fakeTui = { requestRender: vi.fn() };
		return new LoginDialogComponent(fakeTui as never, "test", vi.fn());
	}

	it("uses spawn('open', [url]) on macOS", async () => {
		setPlatform("darwin");
		const dialog = await createDialog();
		const url = "https://example.com/auth";
		dialog.showAuth(url);

		expect(child_process.spawn).toHaveBeenCalledWith(
			"open",
			[url],
			expect.objectContaining({ stdio: "ignore", detached: true }),
		);
	});

	it("uses spawn('rundll32', ['url.dll,FileProtocolHandler', url]) on Windows", async () => {
		setPlatform("win32");
		const dialog = await createDialog();
		const url = "https://example.com/auth";
		dialog.showAuth(url);

		expect(child_process.spawn).toHaveBeenCalledWith(
			"rundll32",
			["url.dll,FileProtocolHandler", url],
			expect.objectContaining({ stdio: "ignore", detached: true }),
		);
	});

	it("uses spawn('xdg-open', [url]) on Linux", async () => {
		setPlatform("linux");
		const dialog = await createDialog();
		const url = "https://example.com/auth";
		dialog.showAuth(url);

		expect(child_process.spawn).toHaveBeenCalledWith(
			"xdg-open",
			[url],
			expect.objectContaining({ stdio: "ignore", detached: true }),
		);
	});

	it("passes URL with shell metacharacters safely as argument (VAL-SEC-002)", async () => {
		setPlatform("darwin");
		const dialog = await createDialog();
		const maliciousUrl = "https://example.com/auth?foo=`rm -rf /`&bar=;echo pwned";
		dialog.showAuth(maliciousUrl);

		expect(child_process.spawn).toHaveBeenCalledWith(
			"open",
			[maliciousUrl],
			expect.objectContaining({ stdio: "ignore", detached: true }),
		);
		// URL is passed as array element, never shell-interpolated
		const callArgs = (child_process.spawn as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(callArgs[1]).toEqual([maliciousUrl]);
	});
});
