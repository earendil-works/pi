import { describe, expect, it } from "vitest";
import { extractToolCallMetricsFromSession } from "../scripts/extract-tool-metrics.ts";
import {
	attachInstrumentation,
	attachProbeToDetails,
	buildInstrumentation,
	categoryForToolName,
	countTextMetrics,
	finalizeDetailsWithInstrumentation,
	resolveInstrumentedFilePath,
} from "../src/core/tool-instrumentation.ts";

describe("tool-instrumentation", () => {
	it("counts text metrics", () => {
		expect(countTextMetrics("a\nb\n")).toEqual({ lines: 2, bytes: 4 });
		expect(countTextMetrics("")).toEqual({ lines: 0, bytes: 0 });
	});

	it("builds instrumentation from probe", () => {
		const instrumentation = buildInstrumentation(
			1_000,
			2_000,
			{
				cwd: "/tmp/project",
				exit_code: 0,
				raw: { lines: 3, bytes: 12 },
				file: {
					arg_path: "README.md",
					path: "/tmp/project/README.md",
					total_lines: 99,
					total_bytes: 512,
				},
			},
			"/fallback",
		);

		expect(instrumentation.v).toBe(1);
		expect(instrumentation.timestamp_start).toBe(new Date(1_000).toISOString());
		expect(instrumentation.timestamp_end).toBe(new Date(2_000).toISOString());
		expect(instrumentation.cwd).toBe("/tmp/project");
		expect(instrumentation.raw).toEqual({ lines: 3, bytes: 12 });
		expect(instrumentation.file?.path).toBe("/tmp/project/README.md");
		expect(instrumentation.file?.total_lines).toBe(99);
	});

	it("finalizes details by stripping probe and attaching instrumentation", () => {
		const finalized = finalizeDetailsWithInstrumentation(
			attachProbeToDetails(
				{ truncation: { truncated: false } },
				{
					cwd: "/tmp/project",
					raw: { lines: 1, bytes: 2 },
				},
			),
			100,
			200,
			"/fallback",
		);

		expect(finalized?.probe).toBeUndefined();
		expect((finalized?.instrumentation as { v?: number } | undefined)?.v).toBe(1);
		expect(finalized?.truncation).toEqual({ truncated: false });
	});

	it("maps categories", () => {
		expect(categoryForToolName("read")).toBe("read");
		expect(categoryForToolName("grep")).toBe("search");
		expect(categoryForToolName("custom-tool")).toBe("execute");
	});

	it("resolves file paths with cwd fallback", () => {
		const instrumentation = buildInstrumentation(
			0,
			1,
			{
				cwd: "/tmp/project",
				raw: { lines: 0, bytes: 0 },
				file: { arg_path: "src/main.ts", path: "/tmp/project/src/main.ts" },
			},
			"/fallback",
		);

		expect(resolveInstrumentedFilePath(instrumentation, "src/main.ts", "/tmp/project")).toBe(
			"/tmp/project/src/main.ts",
		);
		expect(resolveInstrumentedFilePath(undefined, "src/main.ts", "/tmp/project")).toBe("/tmp/project/src/main.ts");
	});

	it("extracts joined tool call metrics from session entries", () => {
		const rows = extractToolCallMetricsFromSession(
			[
				{
					type: "session",
					id: "session-1",
					cwd: "/tmp/project",
				},
				{
					type: "message",
					id: "assistant-1",
					timestamp: "2026-01-01T00:00:00.000Z",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "call_1",
								name: "read",
								arguments: { path: "README.md" },
							},
						],
					},
				},
				{
					type: "message",
					id: "result-1",
					timestamp: "2026-01-01T00:00:01.000Z",
					message: {
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "read",
						content: [{ type: "text", text: "hello\nworld" }],
						details: attachInstrumentation(undefined, {
							v: 1,
							timestamp_start: "2026-01-01T00:00:00.100Z",
							timestamp_end: "2026-01-01T00:00:00.900Z",
							cwd: "/tmp/project",
							raw: { lines: 2, bytes: 11 },
							file: {
								path: "/tmp/project/README.md",
								arg_path: "README.md",
								total_lines: 10,
								total_bytes: 100,
							},
						}),
					},
				},
			],
			"session-1",
		);

		expect(rows).toHaveLength(1);
		expect(rows[0]?.tool_name).toBe("read");
		expect(rows[0]?.category).toBe("read");
		expect(rows[0]?.file_path).toBe("/tmp/project/README.md");
		expect(rows[0]?.lines_returned).toBe(2);
		expect(rows[0]?.lines_sent_to_model).toBe(2);
		expect(rows[0]?.bytes_returned).toBe(11);
		expect(rows[0]?.total_file_lines).toBe(10);
	});
});
