import type * as ChildProcess from "node:child_process";
import type * as Fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPowerShellConfig, getShellConfig } from "../src/utils/shell.ts";

const { accessSyncMock, spawnSyncMock } = vi.hoisted(() => ({
	accessSyncMock: vi.fn(),
	spawnSyncMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof Fs>();
	return {
		...actual,
		accessSync: accessSyncMock,
	};
});

vi.mock("child_process", async (importOriginal) => ({
	...(await importOriginal<typeof ChildProcess>()),
	spawnSync: spawnSyncMock,
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const aliasesDir = "D:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps";

function stubPlatform(platform: string) {
	Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

beforeEach(() => {
	vi.stubEnv("ProgramFiles", undefined);
	vi.stubEnv("ProgramFiles(x86)", undefined);
	accessSyncMock.mockReset();
	spawnSyncMock.mockReset();
});

afterEach(() => {
	Object.defineProperty(process, "platform", platformDescriptor);
	vi.unstubAllEnvs();
});

// nodejs/node#36790: runnable Store aliases pass access(F_OK) but fail the extra
// stat check existsSync performs on Windows only.
describe("Windows Store shell aliases", () => {
	beforeEach(() => {
		stubPlatform("win32");
	});

	it.each(["bash.exe", "pwsh.exe"])("accepts %s found on PATH", (executable) => {
		const alias = `${aliasesDir}\\${executable}`;
		spawnSyncMock.mockReturnValue({ status: 0, stdout: `${alias}\r\n` });

		const config = executable === "pwsh.exe" ? getPowerShellConfig() : getShellConfig();

		expect(config.shell).toBe(alias);
	});

	it("accepts an explicitly configured shell alias", () => {
		const alias = `${aliasesDir}\\bash.exe`;

		expect(getShellConfig(alias).shell).toBe(alias);
	});

	it("still rejects PATH results that fail the existence check", () => {
		const windowsPowerShell = "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
		spawnSyncMock
			.mockReturnValueOnce({ status: 0, stdout: `${aliasesDir}\\pwsh.exe` })
			.mockReturnValueOnce({ status: 0, stdout: windowsPowerShell });
		accessSyncMock.mockImplementationOnce(() => {
			throw Object.assign(new Error("not found"), { code: "ENOENT" });
		});

		expect(getPowerShellConfig().shell).toBe(windowsPowerShell);
	});
});

// The access(F_OK) check is intentionally used on every platform, matching
// harness-v2 (packages/durable/src/env/node.ts pathExists). On Unix it is the
// same syscall existsSync already performs.
describe("Unix shell existence checks", () => {
	beforeEach(() => {
		stubPlatform("linux");
	});

	it("accepts /bin/bash when access(F_OK) succeeds", () => {
		expect(getShellConfig().shell).toBe("/bin/bash");
	});

	it("falls back to bash on PATH when /bin/bash fails access(F_OK)", () => {
		accessSyncMock.mockImplementationOnce(() => {
			throw Object.assign(new Error("not found"), { code: "ENOENT" });
		});
		spawnSyncMock.mockReturnValue({ status: 0, stdout: "/usr/local/bin/bash\n" });

		expect(getShellConfig().shell).toBe("/usr/local/bin/bash");
	});

	it("rejects an explicitly configured shell path that fails access(F_OK)", () => {
		accessSyncMock.mockImplementationOnce(() => {
			throw Object.assign(new Error("not found"), { code: "ENOENT" });
		});

		expect(() => getShellConfig("/missing/bash")).toThrow("Custom shell path not found: /missing/bash");
	});
});
