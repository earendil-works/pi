import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShellOutputUpdate, ShellOutputView } from "../src/env/index.ts";
import { applyShellOutputUpdate, OutputCapture, sanitizeShellOutput } from "../src/env/utils/output-capture.ts";

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

	it("flushes an incomplete byte sequence before a string chunk", () => {
		const { capture } = createCapture();
		capture.push(new TextEncoder().encode("😀").subarray(0, 2));
		capture.push("x");
		expect(capture.snapshot()).toMatchObject({ text: "\ufffdx", truncation: { totalBytes: 4 } });
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

	it("ignores input and publication after dispose", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { capture, updates } = createCapture();
		capture.push("kept");
		capture.dispose();
		capture.push(" dropped");
		capture.setSpillPath("/tmp/dropped.log");
		capture.flush();
		vi.advanceTimersByTime(1_000);
		expect(updates).toHaveLength(1);
		expect(capture.snapshot().text).toBe("kept");
	});

	it("preserves the original head after its raw guard is crossed", () => {
		vi.useFakeTimers();
		const { capture } = createCapture({ maxBytes: 100, maxLines: 2, retain: "head" });
		capture.push(`first\nsecond\n${"tail".repeat(100)}`);
		expect(capture.snapshot().text).toBe("first\nsecond");
	});

	it("reports exact totals and the first limit reached while retaining the head", () => {
		vi.useFakeTimers();
		const byLines = createCapture({ maxBytes: 1_000, maxLines: 2, retain: "head" }).capture;
		for (let index = 1; index <= 5; index++) byLines.push(`line-${index}\n`);
		expect(byLines.snapshot()).toMatchObject({
			text: "line-1\nline-2",
			truncation: {
				truncated: true,
				truncatedBy: "lines",
				totalLines: 5,
				totalBytes: 35,
				outputLines: 2,
				outputBytes: 13,
			},
		});

		const byBytes = createCapture({ maxBytes: 10, maxLines: 100, retain: "head" }).capture;
		byBytes.push("abcd\nefgh\nijkl");
		expect(byBytes.snapshot()).toMatchObject({
			text: "abcd\nefgh",
			truncation: { truncated: true, truncatedBy: "bytes", totalLines: 3, totalBytes: 14, outputBytes: 9 },
		});
	});

	it("does not report truncation at exactly the configured limits", () => {
		vi.useFakeTimers();
		const { capture } = createCapture({ maxBytes: 11, maxLines: 2, retain: "head" });
		capture.push("hello\nworld");
		expect(capture.truncated).toBe(false);
		expect(capture.snapshot()).toMatchObject({
			text: "hello\nworld",
			truncation: { truncated: false, truncatedBy: null, totalLines: 2, totalBytes: 11 },
		});
		capture.push("\n");
		expect(capture.truncated).toBe(true);
		expect(capture.snapshot().truncation).toMatchObject({ truncatedBy: "bytes", totalLines: 2, totalBytes: 12 });
	});

	it("reports the first limit reached when bytes and lines are both exceeded", () => {
		vi.useFakeTimers();
		const head = createCapture({ maxBytes: 5, maxLines: 2, retain: "head" }).capture;
		head.push("abcdef\nx\ny");
		expect(head.snapshot()).toMatchObject({
			text: "",
			truncation: {
				truncated: true,
				truncatedBy: "bytes",
				firstLineExceedsLimit: true,
				totalLines: 3,
				totalBytes: 10,
			},
		});

		const tail = createCapture({ maxBytes: 5, maxLines: 2, retain: "tail" }).capture;
		tail.push("a\nb\nc\nlonglonglong");
		expect(tail.snapshot()).toMatchObject({
			text: "glong",
			lastLineBytes: 12,
			truncation: { truncated: true, truncatedBy: "bytes", lastLinePartial: true, totalLines: 4 },
		});
	});

	it("keeps limit evidence when small byte limits trim multi-byte edge characters", () => {
		vi.useFakeTimers();
		const head = createCapture({ maxBytes: 1, maxLines: 1, retain: "head" }).capture;
		head.push(`😀\n${"x".repeat(100)}`);
		expect(head.snapshot()).toMatchObject({
			text: "",
			truncation: { truncatedBy: "bytes", firstLineExceedsLimit: true, totalLines: 2, totalBytes: 105 },
		});

		const tail = createCapture({ maxBytes: 1, maxLines: 1, retain: "tail" }).capture;
		tail.push(`${"x".repeat(100)}\n😀`);
		expect(tail.snapshot()).toMatchObject({
			text: "",
			lastLineBytes: 4,
			truncation: { truncatedBy: "bytes", lastLinePartial: true, totalLines: 2, totalBytes: 105 },
		});
	});

	it("reports the full byte length of an oversized newline-terminated retained tail line", () => {
		vi.useFakeTimers();
		const single = createCapture({ maxBytes: 10 }).capture;
		single.push(`${"x".repeat(100)}\n`);
		expect(single.snapshot()).toMatchObject({
			text: "x".repeat(10),
			lastLineBytes: 100,
			truncation: { lastLinePartial: true, totalLines: 1, totalBytes: 101 },
		});

		const chunked = createCapture({ maxBytes: 10 }).capture;
		chunked.push("x".repeat(60));
		chunked.push(`${"x".repeat(40)}\n`);
		expect(chunked.snapshot().lastLineBytes).toBe(100);

		const afterEarlierLine = createCapture({ maxBytes: 10 }).capture;
		afterEarlierLine.push(`short\n${"é".repeat(50)}\n`);
		expect(afterEarlierLine.snapshot().lastLineBytes).toBe(100);

		const leadingNewline = createCapture({ maxBytes: 10 }).capture;
		leadingNewline.push("x".repeat(50));
		leadingNewline.push("\n");
		expect(leadingNewline.snapshot().lastLineBytes).toBe(50);
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

	it("routes trailing publication failures to its error handler", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const errors: unknown[] = [];
		let fail = false;
		const capture = new OutputCapture({ limits: { maxBytes: 50, maxLines: 10 } }, BACKGROUND_CONTEXT, {
			onUpdate: () => {
				if (fail) throw new Error("consumer failed");
			},
			onError: (error) => errors.push(error),
		});
		capture.push("a");
		fail = true;
		capture.push("b");
		vi.advanceTimersByTime(100);
		expect(errors).toEqual([new Error("consumer failed")]);
		capture.dispose();
	});

	it.each([
		{ maxBytes: 0, maxLines: 1 },
		{ maxBytes: Number.POSITIVE_INFINITY, maxLines: 1 },
		{ maxBytes: 1, maxLines: 0 },
		{ maxBytes: 1, maxLines: 1.5 },
	])("rejects invalid limits %o", (limits) => {
		expect(() => new OutputCapture({ limits }, BACKGROUND_CONTEXT, { onError: () => {} })).toThrow(TypeError);
	});
});

describe("applyShellOutputUpdate", () => {
	it("folds every update kind into the published view", () => {
		const metadata = {
			truncation: {
				truncated: true,
				truncatedBy: "bytes" as const,
				totalLines: 1,
				totalBytes: 9,
				outputLines: 1,
				outputBytes: 4,
				lastLinePartial: true,
				firstLineExceedsLimit: false,
				maxLines: 10,
				maxBytes: 4,
			},
		};
		let view = applyShellOutputUpdate(undefined, { kind: "replace", output: { text: "ab", ...metadata } });
		view = applyShellOutputUpdate(view, { kind: "append", text: "cd", metadata });
		expect(view.text).toBe("abcd");
		view = applyShellOutputUpdate(view, { kind: "slide", drop: 2, text: "ef", metadata });
		expect(view.text).toBe("cdef");
		view = applyShellOutputUpdate(view, { kind: "metadata", metadata: { ...metadata, spillPath: "/tmp/full.log" } });
		expect(view).toMatchObject({ text: "cdef", spillPath: "/tmp/full.log" });
	});
});
