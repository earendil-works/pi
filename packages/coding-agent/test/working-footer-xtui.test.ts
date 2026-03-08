import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("working status footer layout", () => {
	it("renders live Working status below the composer/footer boundary", () => {
		let stdout = "";
		let stderr = "";

		try {
			stdout = execFileSync("npx", ["tsx", "test/manual/working-footer-xtui-suite.ts", "--expect", "target"], {
				cwd: process.cwd(),
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error: unknown) {
			if (error && typeof error === "object") {
				const maybeStdout = (error as { stdout?: string }).stdout;
				const maybeStderr = (error as { stderr?: string }).stderr;
				stdout = typeof maybeStdout === "string" ? maybeStdout : "";
				stderr = typeof maybeStderr === "string" ? maybeStderr : "";
			}
		}

		expect(`${stdout}\n${stderr}`).toContain("Verification passed for expectation: target");
	});
});
