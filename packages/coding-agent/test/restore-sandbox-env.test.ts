import { describe, expect, it, vi } from "vitest";

const readFileSync = vi.fn();

vi.mock("node:fs", () => ({
	readFileSync,
}));

const { restoreSandboxEnv } = await import("../src/bun/restore-sandbox-env.js");

describe("restoreSandboxEnv", () => {
	it("does nothing when not running under bun", () => {
		const originalVersions = Object.getOwnPropertyDescriptor(process, "versions");
		Object.defineProperty(process, "versions", {
			value: { node: "20.0.0" },
		});
		const envBefore = { ...process.env };

		restoreSandboxEnv();

		expect(process.env).toEqual(envBefore);

		if (originalVersions) {
			Object.defineProperty(process, "versions", originalVersions);
		}
	});

	it("does nothing when process.env already has entries", () => {
		const originalVersions = Object.getOwnPropertyDescriptor(process, "versions");
		Object.defineProperty(process, "versions", {
			value: { bun: "1.2.0", node: "20.0.0" },
		});
		process.env.RESTORE_SANDBOX_ENV_TEST = "1";
		const envBefore = { ...process.env };

		restoreSandboxEnv();

		expect(process.env).toEqual(envBefore);
		delete process.env.RESTORE_SANDBOX_ENV_TEST;

		if (originalVersions) {
			Object.defineProperty(process, "versions", originalVersions);
		}
	});

	it("restores environment from /proc/self/environ when bun env is empty", () => {
		const originalVersions = Object.getOwnPropertyDescriptor(process, "versions");
		Object.defineProperty(process, "versions", {
			value: { bun: "1.2.0", node: "20.0.0" },
		});

		// Clear env to simulate the bun sandbox bug.
		const envBackup = { ...process.env };
		for (const key of Object.keys(process.env)) {
			delete process.env[key];
		}

		readFileSync.mockReturnValue("FOO=bar\0BAZ=qux\0");

		restoreSandboxEnv();

		expect(readFileSync).toHaveBeenCalledWith("/proc/self/environ", "utf-8");
		expect(process.env.FOO).toBe("bar");
		expect(process.env.BAZ).toBe("qux");

		// Restore.
		for (const key of Object.keys(process.env)) {
			delete process.env[key];
		}
		Object.assign(process.env, envBackup);

		if (originalVersions) {
			Object.defineProperty(process, "versions", originalVersions);
		}
		readFileSync.mockReset();
	});
});
