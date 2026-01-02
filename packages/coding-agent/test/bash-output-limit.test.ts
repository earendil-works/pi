import { describe, expect, it } from "vitest";
import { bashTool } from "../src/tools/bash.js";

const MAX_OUTPUT_BYTES = 32 * 1024; // 32KB - must match bash.ts

describe("bash tool output limit behavior", () => {
	/**
	 * Verify that the process is NOT killed when output exceeds 32KB.
	 * Instead, output capture stops but the process continues to completion.
	 */
	it("should let process complete after output limit is reached", async () => {
		// This test verifies the fix for the pre-commit hook issue:
		// Processes should continue running (not be killed) even when output > 32KB

		// Create a command that:
		// 1. Outputs more than 32KB (to hit the limit)
		// 2. Continues running and exits successfully
		const chunk = "a".repeat(MAX_OUTPUT_BYTES + 1000);
		const testScript = `
#!/bin/bash
echo "${chunk}"
# Verify we're still running after the limit
echo "Still alive!"
exit 0
`;

		// This should succeed because the process completes despite truncation
		const result = await bashTool.execute("test-output-limit", {
			command: testScript,
		});

		// Verify output includes truncation notice
		const textContent = result.content.find((c) => c.type === "text");
		const output = textContent?.text || "";
		expect(output).toContain(`(output truncated to ${MAX_OUTPUT_BYTES} bytes)`);
		expect(output).not.toContain("Still alive!"); // This came after limit

		// The key assertion: tool RESOLVES (not rejects) because process completed
		expect(result.content).toBeDefined();
	}, 10000);

	/**
	 * Verify that error codes are preserved even with truncated output.
	 * This ensures processes like git commands can signal failures correctly.
	 */
	it("should preserve exit code even with truncated output", async () => {
		const chunk = "b".repeat(MAX_OUTPUT_BYTES + 1000);
		const testScript = `
#!/bin/bash
echo "${chunk}"
echo "Some error output"
exit 1
`;

		// Should reject because exit code is non-zero
		await expect(
			bashTool.execute("test-exit-code", {
				command: testScript,
			}),
		).rejects.toThrow(/Command exited with code 1/);
	}, 10000);

	/**
	 * Verify output at exactly 32KB boundary doesn't show truncation notice.
	 * Note: echo adds a newline, so we use (32KB - 1) to stay under limit.
	 */
	it("should not show truncation notice when output just under limit", async () => {
		// Generate (32KB - 1) bytes (plus echo's newline = 32KB bytes total)
		const nearLimit = "c".repeat(MAX_OUTPUT_BYTES - 1);
		const testScript = `echo "${nearLimit}"`;

		const result = await bashTool.execute("test-exact-boundary", {
			command: testScript,
		});

		const textContent = result.content.find((c) => c.type === "text");
		const output = textContent?.text || "";
		expect(output).not.toContain("output truncated");
	}, 5000);

	/**
	 * Simulate git commit with verbose pre-commit hook that outputs > 32KB.
	 * This is the real-world scenario that was broken before the fix.
	 */
	it("should handle git commit with verbose pre-commit hook", async () => {
		// Create a simulation of a git commit workflow:
		// 1. Pre-commit hook outputs verbose linting/test results (> 32KB)
		// 2. Hook returns success
		// 3. Commit proceeds

		const hookOutput = "Lint check passed\n".repeat(3000); // ~51KB
		const testScript = `
#!/bin/bash
# Simulate a verbose pre-commit hook
echo "${hookOutput}"
echo "Pre-commit checks completed successfully"
exit 0
`;

		const result = await bashTool.execute("test-git-commit-sim", {
			command: testScript,
		});

		const textContent = result.content.find((c) => c.type === "text");
		const output = textContent?.text || "";
		// Should show truncation notice
		expect(output).toContain(`(output truncated to ${MAX_OUTPUT_BYTES} bytes)`);
		// Should NOT include the final success message (came after limit)
		expect(output).not.toContain("Pre-commit checks completed successfully");
		// But the tool should RESOLVE (not reject) because the process succeeded
		expect(result.content.length).toBeGreaterThan(0);
	}, 10000);

	/**
	 * Verify small commands work normally (no truncation).
	 */
	it("should handle small output without truncation", async () => {
		const result = await bashTool.execute("test-small-output", {
			command: "echo 'Hello world'",
		});

		const textContent = result.content.find((c) => c.type === "text");
		const output = textContent?.text || "";
		expect(output).toContain("Hello world");
		expect(output).not.toContain("truncated");
	}, 5000);
});
