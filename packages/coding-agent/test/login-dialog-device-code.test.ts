import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { copyToClipboard } from "../src/utils/clipboard.ts";
import { openBrowser } from "../src/utils/open-browser.ts";

vi.mock("../src/utils/clipboard.ts", () => ({ copyToClipboard: vi.fn() }));
vi.mock("../src/utils/open-browser.ts", () => ({ openBrowser: vi.fn() }));

const device = { userCode: "ABCD-EFGH", verificationUri: "https://example.com/device" };

function createDialog() {
	const onComplete = vi.fn();
	const dialog = new LoginDialogComponent({ requestRender: vi.fn() } as unknown as TUI, "custom-provider", onComplete);
	dialog.focused = true;
	return { dialog, onComplete };
}

function render(dialog: LoginDialogComponent): string {
	return stripAnsi(dialog.render(120).join("\n"));
}

// Regression #9282: device-code convenience actions require explicit confirmation.
describe("device-code login", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(copyToClipboard).mockResolvedValue(undefined);
		setKeybindings(new KeybindingsManager());
	});

	it("opens the verification page and copies the code once after confirmation", async () => {
		const { dialog } = createDialog();
		const domain = dialog.showPrompt("GitHub Enterprise URL/domain (blank for github.com)");
		dialog.handleInput("\r");
		await expect(domain).resolves.toBe("");
		dialog.showDeviceCode(device);
		dialog.showWaiting("Waiting for authentication...");
		expect(render(dialog)).toContain("to open browser and copy code");
		expect(openBrowser).not.toHaveBeenCalled();
		expect(copyToClipboard).not.toHaveBeenCalled();

		dialog.handleInput("\r");
		await Promise.resolve();
		dialog.handleInput("\r");
		expect(openBrowser).toHaveBeenCalledExactlyOnceWith(device.verificationUri);
		expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith(device.userCode);
		expect(render(dialog)).toContain("Code copied to clipboard");
		expect(render(dialog)).toContain(`Enter code: ${device.userCode}`);
		expect(render(dialog)).toContain("Waiting for authentication...");
		expect(render(dialog)).not.toContain("to open browser and copy code");
	});

	it.each([
		[false, false],
		[true, false],
		[false, true],
	] as const)(
		"honors browser=%s / clipboard=%s provider overrides",
		async (openBrowserOnConfirm, copyCodeOnConfirm) => {
			const { dialog } = createDialog();
			dialog.showDeviceCode({ ...device, openBrowserOnConfirm, copyCodeOnConfirm });
			dialog.handleInput("\r");
			await Promise.resolve();
			expect(openBrowser).toHaveBeenCalledTimes(openBrowserOnConfirm ? 1 : 0);
			expect(copyToClipboard).toHaveBeenCalledTimes(copyCodeOnConfirm ? 1 : 0);
			expect(dialog.signal.aborted).toBe(false);
		},
	);

	it("clears the previous auth URL copy action when showing a device code", () => {
		const { dialog } = createDialog();
		dialog.showAuth("https://example.com/authorize");
		vi.mocked(openBrowser).mockClear();
		dialog.showDeviceCode(device);
		dialog.handleInput("\x18");
		expect(copyToClipboard).not.toHaveBeenCalled();
		expect(openBrowser).not.toHaveBeenCalled();
		dialog.handleInput("\r");
		expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith(device.userCode);
	});

	it("clears device actions when switching to browser authentication", () => {
		const { dialog } = createDialog();
		dialog.showDeviceCode(device);
		dialog.showAuth("https://example.com/authorize");
		vi.mocked(openBrowser).mockClear();
		dialog.handleInput("\r");
		expect(copyToClipboard).not.toHaveBeenCalled();
		expect(openBrowser).not.toHaveBeenCalled();
		dialog.handleInput("\x18");
		expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith("https://example.com/authorize");
	});

	it("clears both action types when showing details", () => {
		const { dialog } = createDialog();
		dialog.showAuth("https://example.com/authorize");
		dialog.showDetails(["Choose a login method"]);
		dialog.handleInput("\x18");
		expect(copyToClipboard).not.toHaveBeenCalled();
		dialog.showDeviceCode(device);
		dialog.showDetails(["Choose a login method"]);
		vi.mocked(openBrowser).mockClear();
		dialog.handleInput("\r");
		expect(copyToClipboard).not.toHaveBeenCalled();
		expect(openBrowser).not.toHaveBeenCalled();
	});

	it("cancels without opening a browser or changing the clipboard", () => {
		const { dialog, onComplete } = createDialog();
		dialog.showDeviceCode(device);
		dialog.handleInput("\x1b");
		dialog.handleInput("\r");
		expect(dialog.signal.aborted).toBe(true);
		expect(onComplete).toHaveBeenCalledExactlyOnceWith(false, "Login cancelled");
		expect(openBrowser).not.toHaveBeenCalled();
		expect(copyToClipboard).not.toHaveBeenCalled();
	});

	it("keeps manual login available when browser and clipboard access fail", async () => {
		vi.mocked(openBrowser).mockImplementation(() => {
			throw new Error("Browser unavailable");
		});
		vi.mocked(copyToClipboard).mockRejectedValue(new Error("Clipboard unavailable"));
		const { dialog, onComplete } = createDialog();
		dialog.showDeviceCode(device);
		dialog.showWaiting("Waiting for authentication...");
		expect(() => dialog.handleInput("\r")).not.toThrow();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(openBrowser).toHaveBeenCalledExactlyOnceWith(device.verificationUri);
		expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith(device.userCode);
		expect(render(dialog)).toContain(device.verificationUri);
		expect(render(dialog)).toContain(`Enter code: ${device.userCode}`);
		expect(render(dialog)).toContain("Copy code manually");
		expect(render(dialog)).toContain("Waiting for authentication...");
		expect(dialog.signal.aborted).toBe(false);
		expect(onComplete).not.toHaveBeenCalled();
	});
});

describe("login URLs", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		vi.resetAllMocks();
		setKeybindings(new KeybindingsManager());
	});

	it("opens only http(s) sign-in URLs", () => {
		const { dialog } = createDialog();
		dialog.showAuth("file:///Users/victim/Downloads/payload.app");
		expect(openBrowser).not.toHaveBeenCalled();

		dialog.showAuth("https://example.com/authorize");
		expect(openBrowser).toHaveBeenCalledExactlyOnceWith("https://example.com/authorize");
	});

	it("keeps control characters in URLs from ending terminal hyperlinks", () => {
		const { dialog } = createDialog();
		dialog.showDeviceCode({ ...device, verificationUri: "https://example.com/device\x07\x1b]52;c;Zm9v\x07" });
		dialog.showInfo("Docs", [{ label: "Help", url: "https://example.com/help\x07\x1b]52;c;Zm9v\x07" }]);
		const output = dialog.render(120).join("\n");

		expect(output).not.toContain("\x1b]52");
		expect(render(dialog)).toContain("https://example.com/device%07%1B]52;c;Zm9v");
		expect(render(dialog)).toContain("Help: https://example.com/help%07%1B]52;c;Zm9v");
	});

	it("replaces control characters in URLs that are not web URLs", () => {
		const injected = "x\x07\x1b]52;c;Zm9v\x07";
		const { dialog } = createDialog();
		dialog.showAuth(`file:///tmp/${injected}`);
		expect(dialog.render(120).join("\n")).not.toContain("\x1b]52");

		dialog.showDeviceCode({ ...device, verificationUri: injected });
		expect(dialog.render(120).join("\n")).not.toContain("\x1b]52");
		expect(render(dialog)).toContain("x ]52;c;Zm9v");

		dialog.showInfo("Docs", [{ label: "Help", url: injected }]);
		expect(dialog.render(120).join("\n")).not.toContain("\x1b]52");
		expect(render(dialog)).toContain("Help: x ]52;c;Zm9v");
		expect(openBrowser).not.toHaveBeenCalled();
	});
});
