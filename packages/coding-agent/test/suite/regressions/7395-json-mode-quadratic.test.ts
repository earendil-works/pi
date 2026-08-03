import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { runPrintMode } from "../../../src/modes/print-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

// Regression for https://github.com/earendil-works/pi/issues/7395

const stdout = vi.hoisted(() => ({
	lines: [] as string[],
}));

vi.mock("../../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		stdout.lines.push(line);
	},
}));

function createRuntimeHost(harness: Harness): AgentSessionRuntime {
	return {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

function parseLines(): Array<Record<string, unknown>> {
	return stdout.lines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("JSON mode output scales with deltas (#7395)", () => {
	afterEach(() => {
		stdout.lines = [];
	});

	test("streams delta-only message_updates and stays linear in output size", async () => {
		const longText = Array.from(
			{ length: 300 },
			(_, i) => `Line ${i + 1}: a distinct sentence of about ten words here.`,
		).join("\n");
		const harness = await createHarness();

		try {
			harness.setResponses([fauxAssistantMessage(longText)]);
			const exitCode = await runPrintMode(createRuntimeHost(harness), {
				mode: "json",
				initialMessage: "Write a long response",
			});
			expect(exitCode).toBe(0);

			const events = parseLines();
			const updates = events.filter((event) => event.type === "message_update");
			const assistantEnds = events.filter(
				(event) => event.type === "message_end" && (event.message as { role?: string }).role === "assistant",
			);
			const finalMessage = assistantEnds.at(-1)?.message;
			const totalBytes = stdout.lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0);
			const finalBytes = Buffer.byteLength(JSON.stringify(finalMessage));
			const maxUpdateBytes = Math.max(...updates.map((update) => Buffer.byteLength(JSON.stringify(update))));

			console.log(
				`#7395 json-mode: updates=${updates.length} totalBytes=${totalBytes} finalBytes=${finalBytes} ` +
					`total/final=${(totalBytes / finalBytes).toFixed(1)} maxUpdate=${maxUpdateBytes}`,
			);

			expect(updates.length).toBeGreaterThan(50);

			// Each streaming update serializes only the incremental event, not the accumulated
			// assistant message. `message_start` and `message_end` carry the complete snapshots.
			for (const update of updates) {
				expect(update.message).toBeUndefined();
				const assistantMessageEvent = update.assistantMessageEvent as Record<string, unknown>;
				expect(assistantMessageEvent.partial).toBeUndefined();
			}
			expect(maxUpdateBytes).toBeLessThan(finalBytes);

			// Linear growth bound: cumulative snapshots would make the stream hundreds of
			// times larger than the final message for this response size.
			expect(totalBytes).toBeLessThan(finalBytes * 15);

			// Completeness: the final message still carries the full response text.
			const finalText = ((finalMessage as { content?: Array<{ type: string; text?: string }> }).content ?? [])
				.filter((part) => part.type === "text")
				.map((part) => part.text ?? "")
				.join("");
			expect(finalText).toBe(longText);
		} finally {
			harness.cleanup();
		}
	});
});
