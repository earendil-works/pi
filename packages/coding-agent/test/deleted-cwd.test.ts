import { afterEach, describe, expect, test, vi } from "vitest";
import { main } from "../src/main.ts";

// Regression test for https://github.com/earendil-works/pi/issues/11509
describe("startup in a deleted working directory", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("prints an actionable error and exits 1 instead of throwing", async () => {
		vi.spyOn(process, "cwd").mockImplementation(() => {
			throw Object.assign(new Error("ENOENT: no such file or directory, uv_cwd"), {
				code: "ENOENT",
				syscall: "uv_cwd",
			});
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`process.exit(${code})`);
		}) as typeof process.exit);

		await expect(main(["--no-extensions", "--version"])).rejects.toThrow("process.exit(1)");
		expect(exitSpy).toHaveBeenCalledWith(1);
		const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
		expect(stderr).toContain("The current working directory no longer exists");
	});

	test("rethrows unrelated cwd errors", async () => {
		vi.spyOn(process, "cwd").mockImplementation(() => {
			throw Object.assign(new Error("EACCES"), { code: "EACCES" });
		});

		await expect(main(["--no-extensions", "--version"])).rejects.toThrow("EACCES");
	});
});
