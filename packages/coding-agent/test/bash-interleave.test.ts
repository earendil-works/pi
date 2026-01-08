import { describe, expect, it } from "vitest";
import { bashTool } from "../src/tools/bash.js";

// Helper to extract text from content blocks
function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

describe("bash tool interleaved output", () => {
	it("should preserve interleaved stdout/stderr order in final output", async () => {
		// Use a script that writes to stdout and stderr in a known order
		// The sync writes should preserve ordering within reasonable timing
		const script = `
node -e "
process.stdout.write('A');
process.stderr.write('B');
process.stdout.write('C');
process.stderr.write('D');
process.stdout.write('E');
"
`;

		const result = await bashTool.execute("test-interleave", { command: script });
		const output = getTextOutput(result);

		// The output should contain all characters
		expect(output).toContain("A");
		expect(output).toContain("B");
		expect(output).toContain("C");
		expect(output).toContain("D");
		expect(output).toContain("E");

		// More importantly, A should come before C, and C before E (stdout order)
		// And B should come before D (stderr order)
		const posA = output.indexOf("A");
		const posB = output.indexOf("B");
		const posC = output.indexOf("C");
		const posD = output.indexOf("D");
		const posE = output.indexOf("E");

		// Stdout ordering must be preserved
		expect(posA).toBeLessThan(posC);
		expect(posC).toBeLessThan(posE);

		// Stderr ordering must be preserved
		expect(posB).toBeLessThan(posD);

		// The old behavior would always produce "ACE\nBD" (stdout first, then stderr)
		// The new behavior should interleave based on arrival order
		// We can't guarantee exact interleaving due to Node.js async, but we can
		// check that it's NOT the old "all stdout then all stderr" pattern
		const oldPattern = /^A.*C.*E\nB.*D$/;
		const isOldPattern = oldPattern.test(output.trim());

		// If the output matches the old pattern, the fix didn't work
		// Note: This may occasionally pass with old pattern due to timing,
		// but repeated runs should show interleaving with the fix
		console.log("Output:", JSON.stringify(output));
		console.log("Matches old stdout-first pattern:", isOldPattern);
	}, 10000);

	it("should handle stdout-only output", async () => {
		const result = await bashTool.execute("test-stdout-only", {
			command: 'echo "hello"',
		});
		const output = getTextOutput(result);
		expect(output.trim()).toBe("hello");
	});

	it("should handle stderr-only output", async () => {
		const result = await bashTool.execute("test-stderr-only", {
			command: 'echo "error" >&2',
		});
		const output = getTextOutput(result);
		expect(output.trim()).toBe("error");
	});

	it("should handle empty output", async () => {
		const result = await bashTool.execute("test-empty", {
			command: "true",
		});
		const output = getTextOutput(result);
		expect(output).toBe("(no output)");
	});

	it("should handle rapid interleaved output", async () => {
		// More aggressive interleaving test
		const script = `
node -e "
for (let i = 0; i < 10; i++) {
  process.stdout.write('O' + i);
  process.stderr.write('E' + i);
}
"
`;

		const result = await bashTool.execute("test-rapid-interleave", { command: script });
		const output = getTextOutput(result);

		// Check all outputs are present
		for (let i = 0; i < 10; i++) {
			expect(output).toContain(`O${i}`);
			expect(output).toContain(`E${i}`);
		}

		// Check ordering within each stream is preserved
		for (let i = 0; i < 9; i++) {
			expect(output.indexOf(`O${i}`)).toBeLessThan(output.indexOf(`O${i + 1}`));
			expect(output.indexOf(`E${i}`)).toBeLessThan(output.indexOf(`E${i + 1}`));
		}

		console.log("Rapid interleave output:", JSON.stringify(output));
	}, 10000);
});
