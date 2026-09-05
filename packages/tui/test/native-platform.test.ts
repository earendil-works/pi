import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, Module } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getNativeClipboard, getNativePlatformHelper } from "../src/native-platform.ts";

test("Linux ARM64 prebuild supports 64 KB system pages", () => {
	const binary = readFileSync(
		new URL("../native/linux/prebuilds/linux-arm64/linux-platform-x11.node", import.meta.url),
	);
	assert.equal(binary.subarray(0, 4).toString(), "\x7fELF");
	const offset = Number(binary.readBigUInt64LE(32));
	const entrySize = binary.readUInt16LE(54);
	const count = binary.readUInt16LE(56);
	let loadSegments = 0;
	for (let index = 0; index < count; index++) {
		const entry = offset + index * entrySize;
		if (binary.readUInt32LE(entry) !== 1) continue;
		loadSegments++;
		const fileOffset = binary.readBigUInt64LE(entry + 8);
		const address = binary.readBigUInt64LE(entry + 16);
		assert.equal((address - fileOffset) % 65536n, 0n);
		assert.ok(binary.readBigUInt64LE(entry + 48) >= 65536n);
	}
	assert.ok(loadSegments > 0);
});

// Opt in on a Windows test desktop: this replaces the system clipboard contents.
test(
	"writes Windows clipboard text through the native helper without command fallbacks",
	{ skip: process.platform !== "win32" || process.env.PI_TEST_NATIVE_CLIPBOARD !== "1" },
	async () => {
		const clipboard = getNativeClipboard();
		assert.ok(clipboard?.setText);
		for (const text of ["clipboard café 日本語", "", "second write"]) {
			await clipboard.setText(text);
			assert.equal(await clipboard.getText(), text);
			assert.equal(await clipboard.getImage(), null);
		}
	},
);

test(
	"uses the native platform helper directly as the clipboard API",
	{ skip: !["darwin", "win32"].includes(process.platform) || !["arm64", "x64"].includes(process.arch) },
	() => {
		const clipboard = getNativeClipboard();
		assert.ok(clipboard);
		assert.equal(typeof clipboard.getText, "function");
		assert.equal(typeof clipboard.getImage, "function");
		assert.equal(typeof clipboard.setText, "function");
		assert.equal(clipboard, getNativePlatformHelper());
		assert.equal(clipboard, getNativeClipboard());
	},
);

test("Linux loads X11 lazily and rechecks DISPLAY", { skip: !["arm64", "x64"].includes(process.arch) }, async (t) => {
	const require = createRequire(import.meta.url);
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	const display = process.env.DISPLAY;
	const waylandDisplay = process.env.WAYLAND_DISPLAY;
	const modulePath = fileURLToPath(
		new URL(`../native/linux/prebuilds/linux-${process.arch}/linux-platform-x11.node`, import.meta.url),
	);
	const previous = require.cache[modulePath];
	t.after(() => {
		Object.defineProperty(process, "platform", platform);
		if (display === undefined) delete process.env.DISPLAY;
		else process.env.DISPLAY = display;
		if (waylandDisplay === undefined) delete process.env.WAYLAND_DISPLAY;
		else process.env.WAYLAND_DISPLAY = waylandDisplay;
		if (previous) require.cache[modulePath] = previous;
		else delete require.cache[modulePath];
	});
	Object.defineProperty(process, "platform", { value: "linux" });
	delete process.env.DISPLAY;
	process.env.WAYLAND_DISPLAY = "wayland-0";
	assert.equal(getNativeClipboard(), undefined); // Wayland paste uses wl-paste.
	let available = false;
	const helper = {
		getText: t.mock.fn(async () => (available ? "X11" : undefined)),
		getImage: t.mock.fn(async () => null),
	};
	const module = new Module(modulePath);
	module.exports = helper;
	require.cache[modulePath] = module;
	process.env.DISPLAY = ":0";
	const clipboard = getNativeClipboard()!;
	assert.equal(clipboard, helper);
	assert.equal(helper.getText.mock.callCount(), 0);
	assert.equal(await clipboard.getText(), undefined);
	available = true;
	assert.equal(await clipboard.getText(), "X11");
	assert.equal(await clipboard.getImage(), null);
	delete process.env.DISPLAY;
	assert.equal(getNativeClipboard(), undefined);
	process.env.DISPLAY = ":1";
	assert.equal(getNativeClipboard(), clipboard);
});
