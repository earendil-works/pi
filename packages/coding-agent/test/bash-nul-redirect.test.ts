import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeNulRedirects } from "../src/core/tools/bash.js";

describe("normalizeNulRedirects", () => {
	it("returns empty string as-is", () => {
		expect(normalizeNulRedirects("")).toBe("");
	});

	it("leaves commands without NUL redirects unchanged", () => {
		expect(normalizeNulRedirects("echo hello")).toBe("echo hello");
		expect(normalizeNulRedirects("grep nul file.txt")).toBe("grep nul file.txt");
	});

	it.skipIf(process.platform === "win32")("does not modify commands on non-Windows platforms", () => {
		expect(normalizeNulRedirects("echo hello > nul")).toBe("echo hello > nul");
		expect(normalizeNulRedirects("echo hello 2>> nul")).toBe("echo hello 2>> nul");
		expect(normalizeNulRedirects("echo hello &>> nul")).toBe("echo hello &>> nul");
	});

	describe.skipIf(process.platform !== "win32")("Windows-only", () => {
		it("does not replace > nul inside quoted strings", () => {
			expect(normalizeNulRedirects('echo "foo > nul bar"')).toBe('echo "foo > nul bar"');
			expect(normalizeNulRedirects("echo 'foo > nul bar'")).toBe("echo 'foo > nul bar'");
			expect(normalizeNulRedirects("echo \"foo 'bar > nul baz'\"")).toBe("echo \"foo 'bar > nul baz'\"");
		});

		it("does not replace > nul inside escaped quotes", () => {
			// Escaped double quotes outside quotes: > nul is outside quotes, so it IS replaced
			expect(normalizeNulRedirects('echo \\"foo > nul bar\\"')).toBe('echo \\"foo >/dev/null bar\\"');

			// Escaped double quote inside double quotes: string stays quoted, > nul stays
			expect(normalizeNulRedirects('echo "foo \\"bar > nul baz"')).toBe('echo "foo \\"bar > nul baz"');

			// Escaped single quote outside quotes: > nul is outside quotes, so it IS replaced
			expect(normalizeNulRedirects("echo \\'foo > nul bar\\'")).toBe("echo \\'foo >/dev/null bar\\'");

			// Escaped single quote inside double quotes: double quotes stay active, > nul stays
			expect(normalizeNulRedirects('echo "foo \\\'bar > nul baz"')).toBe('echo "foo \\\'bar > nul baz"');
		});

		it("replaces all NUL redirect variants on Windows", () => {
			// stdout overwrite
			expect(normalizeNulRedirects("echo hello >nul")).toBe("echo hello >/dev/null");
			expect(normalizeNulRedirects("echo hello > nul")).toBe("echo hello >/dev/null");
			expect(normalizeNulRedirects("echo hello >NUL")).toBe("echo hello >/dev/null");
			expect(normalizeNulRedirects("echo hello >  nul")).toBe("echo hello >/dev/null");

			// stdout append
			expect(normalizeNulRedirects("echo hello >> nul")).toBe("echo hello >>/dev/null");
			expect(normalizeNulRedirects("echo hello >>  NUL")).toBe("echo hello >>/dev/null");

			// stderr overwrite with fd adjacent to operator
			expect(normalizeNulRedirects("echo hello 1> nul")).toBe("echo hello 1>/dev/null");
			expect(normalizeNulRedirects("echo hello 2> nul")).toBe("echo hello 2>/dev/null");

			// stderr append with fd adjacent to operator
			expect(normalizeNulRedirects("echo hello 1>> nul")).toBe("echo hello 1>>/dev/null");
			expect(normalizeNulRedirects("echo hello 2>> nul")).toBe("echo hello 2>>/dev/null");

			// stdout + stderr overwrite
			expect(normalizeNulRedirects("echo hello &> nul")).toBe("echo hello &>/dev/null");
			expect(normalizeNulRedirects("echo hello &>  Nul")).toBe("echo hello &>/dev/null");

			// stdout + stderr append
			expect(normalizeNulRedirects("echo hello &>> nul")).toBe("echo hello &>>/dev/null");
			expect(normalizeNulRedirects("echo hello &>>  NuL")).toBe("echo hello &>>/dev/null");
		});

		it("does not rewrite nul when it is part of a filename", () => {
			expect(normalizeNulRedirects("echo data > nul.txt")).toBe("echo data > nul.txt");
			expect(normalizeNulRedirects("echo data > nul-backup")).toBe("echo data > nul-backup");
			expect(normalizeNulRedirects("echo data > nul_suffix")).toBe("echo data > nul_suffix");
			expect(normalizeNulRedirects("echo data 1 > nul.txt")).toBe("echo data 1 > nul.txt");
		});

		it("preserves fd as an argument when separated from the operator by whitespace", () => {
			// When fd is not adjacent to the operator it is a normal argument;
			// only the redirect target is rewritten.
			expect(normalizeNulRedirects("echo hello 1 > nul")).toBe("echo hello 1 >/dev/null");
			expect(normalizeNulRedirects("echo hello 2  >  nul")).toBe("echo hello 2  >/dev/null");
			expect(normalizeNulRedirects("echo hello 2 >>  nul")).toBe("echo hello 2 >>/dev/null");
		});

		it("does not replace escaped redirect operators", () => {
			// Odd counts: operator is escaped, stays literal.
			expect(normalizeNulRedirects("echo \\> nul")).toBe("echo \\> nul");
			expect(normalizeNulRedirects("echo 1\\> nul")).toBe("echo 1\\> nul");
			expect(normalizeNulRedirects("echo \\\\\\> nul")).toBe("echo \\\\\\> nul");

			// Even counts: operator is NOT escaped, gets replaced.
			expect(normalizeNulRedirects("echo \\\\\\\\> nul")).toBe("echo \\\\\\\\>/dev/null");
			expect(normalizeNulRedirects("echo \\\\\\\\\\\\> nul")).toBe("echo \\\\\\\\\\\\>/dev/null");
		});

		it("handles bare redirects and control-character boundaries", () => {
			expect(normalizeNulRedirects(">nul")).toBe(">/dev/null");
			expect(normalizeNulRedirects("> nul")).toBe(">/dev/null");
			expect(normalizeNulRedirects("echo a > nul && echo b > nul")).toBe("echo a >/dev/null && echo b >/dev/null");
			expect(normalizeNulRedirects("echo hello > nul|cat")).toBe("echo hello >/dev/null|cat");
			expect(normalizeNulRedirects("echo hello > nul; echo world")).toBe("echo hello >/dev/null; echo world");
		});

		it("treats backslashes as literal inside single quotes", () => {
			// In Bash, backslashes inside single quotes are literal; \' does NOT
			// escape the closing quote. The quote closes normally and the redirect
			// that follows is still normalized.
			expect(normalizeNulRedirects("echo 'foo\\' > nul")).toBe("echo 'foo\\' >/dev/null");
			expect(normalizeNulRedirects("echo 'foo\\\\' > nul")).toBe("echo 'foo\\\\' >/dev/null");

			// Outside single quotes, \' is an escaped literal quote and should not
			// toggle quote state, so the redirect following it is still normalized.
			expect(normalizeNulRedirects("echo \\' > nul")).toBe("echo \\' >/dev/null");
		});
	});
});

describe.skipIf(process.platform !== "win32")("bash tool NUL redirect integration", () => {
	let testDir: string | undefined;

	afterEach(() => {
		if (testDir) {
			rmSync(testDir, { recursive: true, force: true });
			testDir = undefined;
		}
	});

	it("does not create a file named nul when redirecting output", async () => {
		const { createLocalBashOperations } = await import("../src/core/tools/bash.js");
		const { existsSync } = await import("node:fs");

		testDir = mkdtempSync(join(tmpdir(), "pi-nul-test-"));
		const ops = createLocalBashOperations();

		await ops.exec("echo hello > nul", testDir, {
			onData: () => {},
		});

		expect(existsSync(join(testDir, "nul"))).toBe(false);
	});
});
