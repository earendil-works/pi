import type * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof ChildProcess>();
	return { ...actual, spawn: spawnMock };
});

import { killProcessTree } from "../../../src/utils/shell.ts";

function withWindowsPlatform(test: () => void): void {
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	try {
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		test();
	} finally {
		if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
	}
}

afterEach(() => {
	spawnMock.mockReset();
	vi.unstubAllEnvs();
});

describe("issue #6596 taskkill spawn failures", () => {
	// #9490: missing or empty SystemRoot must retain an absolute taskkill fallback.
	it.each([
		["D:\\CustomWindows", "D:\\CustomWindows"],
		[undefined, "C:\\Windows"],
		["", "C:\\Windows"],
	] as const)("uses System32 taskkill and consumes its spawn error with SystemRoot=%j", (systemRoot, expectedRoot) => {
		const child = new EventEmitter();
		vi.stubEnv("SystemRoot", systemRoot);
		spawnMock.mockReturnValue(child);

		withWindowsPlatform(() => {
			killProcessTree(1234);
		});

		expect(spawnMock).toHaveBeenCalledWith(
			join(expectedRoot, "System32", "taskkill.exe"),
			["/F", "/T", "/PID", "1234"],
			{ detached: true, stdio: "ignore", windowsHide: true },
		);
		expect(() => child.emit("error", new Error("spawn taskkill ENOENT"))).not.toThrow();
	});
});
