import type * as Fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getShellConfig } from "../src/utils/shell.ts";

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof Fs>()),
	accessSync: () => {},
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(() => {
	Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
});

afterEach(() => {
	Object.defineProperty(process, "platform", platformDescriptor);
	vi.unstubAllEnvs();
});

describe("shellPath environment variable expansion", () => {
	it(`expands $VAR and \${VAR} on Unix`, () => {
		vi.stubEnv("MY_HOME", "/home/tester");

		expect(getShellConfig("$MY_HOME/bin/bash")).toEqual({ shell: "/home/tester/bin/bash", args: ["-c"] });
		expect(getShellConfig(`\${MY_HOME}/bin/bash`)).toEqual({ shell: "/home/tester/bin/bash", args: ["-c"] });
	});

	it("expands %VAR% on Windows", () => {
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		vi.stubEnv("MY_HOME", "C:\\Users\\tester");

		expect(getShellConfig("%MY_HOME%\\Git\\bin\\bash.exe")).toEqual({
			shell: "C:\\Users\\tester\\Git\\bin\\bash.exe",
			args: ["-c"],
		});
	});

	it("matches Windows variable names case-insensitively", () => {
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		vi.stubEnv("MY_HOME", "C:\\Users\\tester");

		expect(getShellConfig("%my_home%\\Git\\bin\\bash.exe")).toEqual({
			shell: "C:\\Users\\tester\\Git\\bin\\bash.exe",
			args: ["-c"],
		});
	});

	it("leaves unset variables untouched on Unix", () => {
		expect(getShellConfig("/bin/$UNSET_VAR/bash")).toEqual({ shell: "/bin/$UNSET_VAR/bash", args: ["-c"] });
	});

	it("leaves unset variables untouched on Windows", () => {
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		expect(getShellConfig("%UNSET_VAR%\\bash.exe")).toEqual({ shell: "%UNSET_VAR%\\bash.exe", args: ["-c"] });
	});
});
