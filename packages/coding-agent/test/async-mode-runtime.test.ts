import { describe, expect, it, vi } from "vitest";
import { type TaskRecord, TaskRuntime } from "../examples/extensions/async-mode/runtime.ts";

const request = {
	id: "question-1",
	sessionId: "session-1",
	text: "Investigate and implement the migration",
	createdAt: "2026-11-04T00:00:00.000Z",
};
const input = {
	request,
	description: "Inspect migration compatibility",
	context: "Use staging fixtures",
	reason: "Multi-module analysis and slow validation",
};

describe("background task lifecycle", () => {
	it("returns before work completes and preserves the originating request", async () => {
		let complete!: (result: { success: boolean; result: string }) => void;
		const persisted: TaskRecord[] = [];
		const notify = vi.fn();
		const runtime = new TaskRuntime((record) => persisted.push(structuredClone(record)), notify);
		const original = { ...request };
		const record = runtime.start(
			{ ...input, request: original },
			async () =>
				new Promise((resolve) => {
					complete = resolve;
				}),
		);
		expect(record.execution.state.status).toBe("running");
		original.text = "Another question";
		await Promise.resolve();
		complete({ success: true, result: "Migration verified" });
		await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
		expect(persisted[0].execution.state.status).toBe("running");
		expect(runtime.events()[0]).toMatchObject({
			request,
			result: "Migration verified",
			taskId: record.task.id,
			status: "completed",
		});
		expect(runtime.events()[0].finishedAt).toBeTruthy();
		await runtime.close();
	});

	it("records failures, and cancels workers independently of foreground turns", async () => {
		const runtime = new TaskRuntime(
			() => {},
			() => {},
		);
		const failed = runtime.start(input, async () => {
			throw new Error("worker failure");
		});
		const cancelled = runtime.start(
			input,
			async (_task, signal) =>
				new Promise((resolve) => {
					signal.addEventListener("abort", () => resolve({ success: false, result: "stopped" }), { once: true });
				}),
		);
		await Promise.resolve();
		runtime.cancel(cancelled.task.id);
		await vi.waitFor(() => expect(runtime.events()).toHaveLength(2));
		expect(failed.execution.state).toMatchObject({ status: "failed", result: "Error: worker failure" });
		expect(cancelled.execution.state.status).toBe("cancelled");
		await runtime.close();
	});

	it("does not replay abandoned work, keeps event IDs stable, and suppresses notifications after close", async () => {
		const records: TaskRecord[] = [];
		const notify = vi.fn();
		const runtime = new TaskRuntime((record) => records.push(structuredClone(record)), notify);
		runtime.start(input, async () => ({ success: true, result: "should not launch after close" }));
		await runtime.close();
		expect(notify).not.toHaveBeenCalled();
		expect(runtime.events()[0].status).toBe("cancelled");
		const restored = new TaskRuntime(
			() => {},
			() => {},
		);
		restored.restore(records[0]);
		restored.recover();
		expect(restored.events()[0].status).toBe("interrupted");
		expect(restored.events()[0].id).toBe(runtime.events()[0].id);
		await restored.close();
	});
});
