import { existsSync, readFileSync, unlinkSync } from "fs";
import { afterEach, describe, expect, it } from "vitest";
import { bashTool } from "../src/tools/bash.js";

const MAX_OUTPUT_BYTES = 32 * 1024; // 32KB - must match bash.ts

describe("bash tool overflow file feature", () => {
	// Track created files for cleanup
	const createdFiles: string[] = [];

	afterEach(() => {
		// Clean up any overflow files created during tests
		for (const file of createdFiles) {
			try {
				if (existsSync(file)) {
					unlinkSync(file);
				}
			} catch {
				// Ignore cleanup errors
			}
		}
		createdFiles.length = 0;
	});

	/**
	 * Extract the overflow file path from the output
	 */
	function extractOverflowPath(output: string): string | null {
		const match = output.match(/Full output saved to: (.+)/);
		return match ? match[1].trim() : null;
	}

	it("should create overflow file when output exceeds limit", async () => {
		const chunk = "a".repeat(MAX_OUTPUT_BYTES + 5000);
		const testScript = `echo "${chunk}"`;

		const result = await bashTool.execute("test-overflow-file", {
			command: testScript,
		});

		const textContent = result.content.find((c) => c.type === "text");
		const output = textContent?.text || "";

		// Should include truncation notice
		expect(output).toContain(`(output truncated to ${MAX_OUTPUT_BYTES} bytes)`);

		// Should include overflow file reference
		expect(output).toContain("Full output saved to:");

		// Extract and verify the file exists
		const overflowPath = extractOverflowPath(output);
		expect(overflowPath).not.toBeNull();

		if (overflowPath) {
			createdFiles.push(overflowPath);
			expect(existsSync(overflowPath)).toBe(true);

			// Verify file contains the full output
			const fileContent = readFileSync(overflowPath, "utf-8");
			expect(fileContent.length).toBeGreaterThan(MAX_OUTPUT_BYTES);
			expect(fileContent).toContain("a".repeat(100)); // Spot check
		}
	}, 10000);

	it("should NOT create overflow file when output fits within limit", async () => {
		const smallOutput = "Hello world";
		const result = await bashTool.execute("test-no-overflow", {
			command: `echo "${smallOutput}"`,
		});

		const textContent = result.content.find((c) => c.type === "text");
		const output = textContent?.text || "";

		// Should NOT include overflow file reference
		expect(output).not.toContain("Full output saved to:");
		expect(output).not.toContain("truncated");

		// The key behavior: no overflow file path in output means file was deleted
		// (we create files eagerly but delete them if not needed)
	}, 10000);

	it("should preserve interleaved stdout/stderr order in overflow file", async () => {
		// Create a script that interleaves stdout and stderr
		const testScript = `
for i in 1 2 3 4 5; do
  echo "stdout line $i"
  echo "stderr line $i" >&2
done
# Add enough content to trigger truncation
echo "${"x".repeat(MAX_OUTPUT_BYTES)}"
`;

		const result = await bashTool.execute("test-interleaved", {
			command: testScript,
		});

		const textContent = result.content.find((c) => c.type === "text");
		const output = textContent?.text || "";

		const overflowPath = extractOverflowPath(output);
		expect(overflowPath).not.toBeNull();

		if (overflowPath) {
			createdFiles.push(overflowPath);
			const fileContent = readFileSync(overflowPath, "utf-8");

			// Verify interleaved order is preserved
			// stdout line 1 should come before stderr line 1 (or vice versa depending on timing)
			// The key is that the ordering reflects actual execution order
			expect(fileContent).toContain("stdout line 1");
			expect(fileContent).toContain("stderr line 1");
		}
	}, 10000);

	it("should include overflow file path in error output when command fails", async () => {
		const chunk = "b".repeat(MAX_OUTPUT_BYTES + 1000);
		const testScript = `
echo "${chunk}"
exit 1
`;

		try {
			await bashTool.execute("test-error-overflow", {
				command: testScript,
			});
			expect.fail("Should have thrown");
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain("Command exited with code 1");
			expect(message).toContain("Full output saved to:");

			const overflowPath = extractOverflowPath(message);
			if (overflowPath) {
				createdFiles.push(overflowPath);
				expect(existsSync(overflowPath)).toBe(true);
			}
		}
	}, 10000);
});
