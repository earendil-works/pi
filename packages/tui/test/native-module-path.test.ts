import assert from "node:assert";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { getNativeModuleCandidates } from "../src/native-module-path.ts";

describe("getNativeModuleCandidates", () => {
	it("resolves native helpers from the installed TUI package when the module is bundled elsewhere", () => {
		const packageRoot = resolve("virtual", "node_modules", "@earendil-works", "pi-tui");
		const bundledModule = resolve("virtual", "pi-coding-agent", "dist", "bundle", "chunks", "chunk.js");
		const nativePath = join("native", "win32", "prebuilds", "win32-arm64", "win32-console-mode.node");

		const candidates = getNativeModuleCandidates(nativePath, {
			moduleUrl: pathToFileURL(bundledModule).href,
			execPath: resolve("virtual", "node", "node.exe"),
			resolvePackage: (specifier) => {
				assert.equal(specifier, "@earendil-works/pi-tui");
				return join(packageRoot, "dist", "index.js");
			},
		});

		assert.equal(candidates[0], join(packageRoot, nativePath));
		assert.ok(candidates.includes(join(dirname(bundledModule), "..", nativePath)));
	});

	it("keeps standalone binary fallbacks when the TUI package is unavailable", () => {
		const bundledModule = resolve("virtual", "pi", "bundle", "chunks", "chunk.js");
		const execPath = resolve("virtual", "pi", "pi.exe");
		const nativePath = join("native", "darwin", "prebuilds", "darwin-arm64", "darwin-modifiers.node");

		const candidates = getNativeModuleCandidates(nativePath, {
			moduleUrl: pathToFileURL(bundledModule).href,
			execPath,
			resolvePackage: () => {
				throw new Error("not installed");
			},
		});

		assert.deepEqual(candidates, [
			join(dirname(bundledModule), "..", nativePath),
			join(dirname(bundledModule), nativePath),
			join(dirname(execPath), nativePath),
		]);
	});
});
