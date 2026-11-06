import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnProcessTree } from "../src/utils/shell.ts";

// The usable-helper check runs once per process, so this test has its own file: a pi-job.exe that cannot run (here
// not an executable at all, as when security software blocks it) must not fail commands; they run without it.
describe.skipIf(process.platform !== "win32")("spawnProcessTree with an unusable pi-job.exe", () => {
	let packageDir: string;

	beforeAll(() => {
		packageDir = mkdtempSync(join(tmpdir(), "pi-job-unusable-"));
		const prebuilds = join(packageDir, "native", "win32", "prebuilds", `win32-${process.arch}`);
		mkdirSync(prebuilds, { recursive: true });
		writeFileSync(join(prebuilds, "pi-job.exe"), "not an executable");
	});

	afterAll(() => {
		rmSync(packageDir, { recursive: true, force: true });
	});

	it("runs commands directly", async () => {
		// Stubbed in the test: the config unstubs environment variables before each test.
		vi.stubEnv("PI_PACKAGE_DIR", packageDir);
		const tree = spawnProcessTree(process.execPath, ["-e", "process.exit(5)"], {
			stdio: "ignore",
			windowsHide: true,
		});
		const code = await new Promise((resolve) => tree.child.once("exit", resolve));
		expect(code).toBe(5);
		expect(tree.child.spawnfile).toBe(process.execPath);
	});
});
