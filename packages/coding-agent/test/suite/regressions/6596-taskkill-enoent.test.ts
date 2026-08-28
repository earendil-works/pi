import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("child_process")>();
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
});

describe("issue #6596 taskkill spawn failures", () => {
	it("uses System32 taskkill and consumes its asynchronous spawn error", () => {
		const child = new EventEmitter() as ChildProcess;
		const previousSystemRoot = process.env.SystemRoot;
		process.env.SystemRoot = "C:\\CustomWindows";
		spawnMock.mockReturnValue(child);

		try {
			withWindowsPlatform(() => {
				killProcessTree(1234);
			});
		} finally {
			if (previousSystemRoot === undefined) delete process.env.SystemRoot;
			else process.env.SystemRoot = previousSystemRoot;
		}

		expect(spawnMock).toHaveBeenCalledWith(
			join("C:\\CustomWindows", "System32", "taskkill.exe"),
			["/F", "/T", "/PID", "1234"],
			{ detached: true, stdio: "ignore", windowsHide: true },
		);
		expect(() => child.emit("error", new Error("spawn taskkill ENOENT"))).not.toThrow();
	});
});
