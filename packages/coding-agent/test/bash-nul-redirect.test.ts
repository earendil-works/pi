import { describe, expect, it } from "vitest";
import { normalizeNulRedirects } from "../src/core/tools/bash.js";

describe("normalizeNulRedirects", () => {
	it("leaves commands without NUL redirects unchanged", () => {
		expect(normalizeNulRedirects("echo hello")).toBe("echo hello");
		expect(normalizeNulRedirects("grep nul file.txt")).toBe("grep nul file.txt");
	});

	it("does not replace > nul inside quoted strings", () => {
		if (process.platform !== "win32") return;

		expect(normalizeNulRedirects('echo "foo > nul bar"')).toBe('echo "foo > nul bar"');
		expect(normalizeNulRedirects("echo 'foo > nul bar'")).toBe("echo 'foo > nul bar'");
	});

	it("replaces all NUL redirect variants on Windows", () => {
		if (process.platform !== "win32") {
			return;
		}

		// stdout overwrite
		expect(normalizeNulRedirects("echo hello > nul")).toBe("echo hello >/dev/null");
		expect(normalizeNulRedirects("echo hello >NUL")).toBe("echo hello >/dev/null");
		expect(normalizeNulRedirects("echo hello >  nul")).toBe("echo hello >/dev/null");

		// stdout append
		expect(normalizeNulRedirects("echo hello >> nul")).toBe("echo hello >>/dev/null");
		expect(normalizeNulRedirects("echo hello >>  NUL")).toBe("echo hello >>/dev/null");

		// stderr overwrite with and without space between fd and >
		expect(normalizeNulRedirects("echo hello 1> nul")).toBe("echo hello 1>/dev/null");
		expect(normalizeNulRedirects("echo hello 1 > nul")).toBe("echo hello 1>/dev/null");
		expect(normalizeNulRedirects("echo hello 2> nul")).toBe("echo hello 2>/dev/null");
		expect(normalizeNulRedirects("echo hello 2  >  nul")).toBe("echo hello 2>/dev/null");

		// stderr append with and without space
		expect(normalizeNulRedirects("echo hello 2>> nul")).toBe("echo hello 2>>/dev/null");
		expect(normalizeNulRedirects("echo hello 2 >>  nul")).toBe("echo hello 2>>/dev/null");

		// stdout + stderr overwrite
		expect(normalizeNulRedirects("echo hello &> nul")).toBe("echo hello &>/dev/null");
		expect(normalizeNulRedirects("echo hello &>  Nul")).toBe("echo hello &>/dev/null");

		// stdout + stderr append
		expect(normalizeNulRedirects("echo hello &>> nul")).toBe("echo hello &>>/dev/null");
		expect(normalizeNulRedirects("echo hello &>>  NuL")).toBe("echo hello &>>/dev/null");
	});

	it("does not modify commands on non-Windows platforms", () => {
		if (process.platform === "win32") {
			return;
		}

		expect(normalizeNulRedirects("echo hello > nul")).toBe("echo hello > nul");
		expect(normalizeNulRedirects("echo hello 2>> nul")).toBe("echo hello 2>> nul");
		expect(normalizeNulRedirects("echo hello &>> nul")).toBe("echo hello &>> nul");
	});
});

describe.skipIf(process.platform !== "win32")("bash tool NUL redirect integration", () => {
	it("does not create a file named nul when redirecting output", async () => {
		const { createLocalBashOperations } = await import("../src/core/tools/bash.js");
		const { existsSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");

		const testDir = join(tmpdir(), `pi-nul-test-${Date.now()}`);
		await import("node:fs").then((fs) => fs.mkdirSync(testDir, { recursive: true }));
		const ops = createLocalBashOperations();

		await ops.exec("echo hello > nul", testDir, {
			onData: () => {},
		});

		expect(existsSync(join(testDir, "nul"))).toBe(false);
	});
});
