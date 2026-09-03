import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import type { ShellOutputUpdate, ShellOutputView } from "../../src/harness/types.ts";
import { applyShellOutputUpdate, OutputCapture, sanitizeShellOutput } from "../../src/harness/utils/output-capture.ts";

function createCapture(options?: { maxBytes?: number; maxLines?: number; retain?: "head" | "tail" }) {
	const updates: ShellOutputUpdate[] = [];
	const errors: unknown[] = [];
	const capture = new OutputCapture(
		{
			limits: {
				maxBytes: options?.maxBytes ?? 50,
				maxLines: options?.maxLines ?? 100,
				retain: options?.retain ?? "tail",
			},
		},
		BACKGROUND_CONTEXT,
		{
			onUpdate: (update) => updates.push(update),
			onError: (error) => errors.push(error),
		},
	);
	return { capture, updates, errors };
}

function fold(updates: ShellOutputUpdate[]): ShellOutputView | undefined {
	let output: ShellOutputView | undefined;
	for (const update of updates) output = applyShellOutputUpdate(output, update);
	return output;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("OutputCapture", () => {
	it("removes invalid control characters without changing text or line boundaries", () => {
		const input = "a\0b\tc\nd\re\u0007f\ufff9g\ufffbh😀";
		expect(sanitizeShellOutput(input)).toBe("ab\tc\ndefgh😀");
		const { capture } = createCapture();
		capture.push(input);
		expect(capture.snapshot().text).toBe("ab\tc\ndefgh😀");
	});
	it("decodes UTF-8 split across raw process chunks", () => {
		const { capture } = createCapture();
		const bytes = new TextEncoder().encode("😀");
		capture.push(bytes.subarray(0, 2));
		expect(capture.snapshot().text).toBe("");
		capture.push(bytes.subarray(2));
		capture.finish();
		expect(capture.snapshot().text).toBe("😀");
	});

	it("publishes the first bounded view immediately and trickling appends responsively", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { capture, updates } = createCapture();

		capture.push("one");
		expect(updates).toHaveLength(1);
		expect(updates[0]?.kind).toBe("replace");

		vi.advanceTimersByTime(150);
		capture.push(" two");
		expect(updates).toHaveLength(2);
		expect(updates[1]).toMatchObject({ kind: "append", text: " two" });
		expect(fold(updates)?.text).toBe("one two");
	});

	it("collapses a burst into one trailing update", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { capture, updates } = createCapture();
		capture.push("a");
		capture.push("b");
		capture.push("c");
		expect(updates).toHaveLength(1);

		vi.advanceTimersByTime(100);
		expect(updates).toHaveLength(2);
		expect(updates[1]).toMatchObject({ kind: "append", text: "bc" });
		expect(fold(updates)?.text).toBe("abc");
	});

	it("publishes a small slide for post-cap trickle", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { capture, updates } = createCapture({ maxBytes: 10 });
		capture.push("abcdefghij");
		vi.advanceTimersByTime(150);
		capture.push("k");

		expect(updates[1]).toMatchObject({ kind: "slide", drop: 1, text: "k" });
		expect(fold(updates)?.text).toBe("bcdefghijk");
		expect(fold(updates)?.truncation.totalBytes).toBe(11);
	});

	it("keeps the exact byte count for a single line larger than its working buffer", () => {
		vi.useFakeTimers();
		const { capture } = createCapture({ maxBytes: 10 });
		capture.push("x".repeat(100));
		expect(capture.snapshot()).toMatchObject({
			text: "x".repeat(10),
			lastLineBytes: 100,
			truncation: { lastLinePartial: true },
		});
	});

	it("uses a cap-bounded replacement after complete turnover", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { capture, updates } = createCapture({ maxBytes: 10 });
		capture.push("abcdefghij");
		capture.push("x".repeat(100));
		vi.advanceTimersByTime(100);

		expect(updates[1]?.kind).toBe("replace");
		expect(fold(updates)?.text).toHaveLength(10);
		expect(fold(updates)?.truncation.totalBytes).toBe(110);
	});

	it("forces held state and cancels its trailing timer on dispose", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { capture, updates } = createCapture();
		capture.push("a");
		capture.push("b");
		capture.flush();
		expect(fold(updates)?.text).toBe("ab");
		capture.dispose();
		vi.advanceTimersByTime(1_000);
		expect(updates).toHaveLength(2);
	});

	it("preserves the original head after its raw guard is crossed", () => {
		vi.useFakeTimers();
		const { capture } = createCapture({ maxBytes: 100, maxLines: 2, retain: "head" });
		capture.push(`first\nsecond\n${"tail".repeat(100)}`);
		expect(capture.snapshot().text).toBe("first\nsecond");
	});

	it("publishes spill metadata without resending text", () => {
		vi.useFakeTimers();
		const { capture, updates, errors } = createCapture();
		capture.push("output");
		capture.setSpillPath("/tmp/output.log");
		expect(updates.at(-1)).toMatchObject({ kind: "metadata", metadata: { spillPath: "/tmp/output.log" } });
		expect(fold(updates)?.spillPath).toBe("/tmp/output.log");
		expect(errors).toEqual([]);
	});
});
