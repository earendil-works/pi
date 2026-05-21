import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTheme, stopThemeWatcher } from "../../../src/modes/interactive/theme/theme.ts";

/**
 * Regression test for https://github.com/earendil-works/pi-mono/issues/2791
 *
 * fs.watch() returns an FSWatcher (EventEmitter). If the watcher emits an
 * 'error' event after creation and no error handler is attached, Node.js
 * treats it as an uncaught exception and terminates the process.
 */
describe("issue #2791 fs.watch error event crashes process", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-2791-"));
		const agentDir = join(tempRoot, "agent");
		const themesDir = join(agentDir, "themes");
		mkdirSync(themesDir, { recursive: true });

		const darkThemePath = join(__dirname, "../../../src/modes/interactive/theme/dark.json");
		const darkTheme = JSON.parse(readFileSync(darkThemePath, "utf-8"));
		darkTheme.name = "custom-test";
		writeFileSync(join(themesDir, "custom-test.json"), JSON.stringify(darkTheme, null, 2));
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("process should survive an error event on the theme FSWatcher", () => {
		const originalAgentDir = process.env.LYLA_CODING_AGENT_DIR;
		process.env.LYLA_CODING_AGENT_DIR = join(tempRoot, "agent");

		try {
			setTheme("custom-test", true);

			const processWithHandles = process as NodeJS.Process & { _getActiveHandles?: () => unknown[] };
			const handles = processWithHandles._getActiveHandles?.() ?? [];
			const fsWatcher = handles.find(
				(
					handle,
				): handle is {
					listenerCount: (event: string) => number;
					emit: (event: string, error: Error) => boolean;
				} => {
					return (handle as { constructor?: { name?: string } }).constructor?.name === "FSWatcher";
				},
			);

			expect(fsWatcher).toBeDefined();
			expect(fsWatcher?.listenerCount("error")).toBeGreaterThan(0);

			// Emitting 'error' on an EventEmitter with no error listener throws.
			// This simulates an async OS error (e.g. ReadDirectoryChangesW invalidation).
			expect(() => fsWatcher?.emit("error", new Error("simulated OS watcher failure"))).not.toThrow();
		} finally {
			stopThemeWatcher();
			if (originalAgentDir === undefined) {
				delete process.env.LYLA_CODING_AGENT_DIR;
			} else {
				process.env.LYLA_CODING_AGENT_DIR = originalAgentDir;
			}
		}
	});
});
