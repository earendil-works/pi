import assert from "node:assert";
import { after, describe, it } from "node:test";
import { refreshTerminalDimensions } from "../src/terminal.ts";

describe("refreshTerminalDimensions", () => {
	const originalKill = process.kill;
	const originalPlatform = process.platform;

	it("does not throw when kill(2) returns EACCES for self-signal", () => {
		Object.defineProperty(process, "platform", { value: "linux" });
		process.kill = ((): typeof process.kill => {
			return (pid, _signal) => {
				if (pid === process.pid) {
					const err = new Error("kill EACCES") as NodeJS.ErrnoException;
					err.code = "EACCES";
					throw err;
				}
				return originalKill.call(process, pid, _signal);
			};
		})();

		assert.doesNotThrow(() => {
			refreshTerminalDimensions();
		});
	});

	it("does not call kill on win32", () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		let killCalled = false;
		process.kill = ((): typeof process.kill => {
			return () => {
				killCalled = true;
				return true;
			};
		})();

		refreshTerminalDimensions();

		assert.strictEqual(killCalled, false, "kill should not be called on win32");
	});

	it("preserves other error codes", () => {
		Object.defineProperty(process, "platform", { value: "linux" });
		process.kill = ((): typeof process.kill => {
			return () => {
				const err = new Error("kill EPERM") as NodeJS.ErrnoException;
				err.code = "EPERM";
				throw err;
			};
		})();

		// EPERM is also ignored - the refresh is best-effort
		assert.doesNotThrow(() => {
			refreshTerminalDimensions();
		});
	});

	after(() => {
		process.kill = originalKill;
		Object.defineProperty(process, "platform", { value: originalPlatform });
	});
});
