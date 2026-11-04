import { describe, expect, it } from "vitest";
import { runProcess } from "../examples/extensions/async-mode/executor.ts";

describe("background subprocess protocol", () => {
	it("ignores malformed output and returns validated assistant text", async () => {
		const script =
			'console.log("noise"); console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"done"}],stopReason:"stop"}}))';
		expect(await runProcess(process.execPath, ["-e", script], process.cwd(), new AbortController().signal)).toEqual({
			success: true,
			result: "done",
		});
	});
	it("surfaces launch failure and cancellation without hanging", async () => {
		expect(
			(await runProcess("/nonexistent/pi-async-executor", [], process.cwd(), new AbortController().signal)).success,
		).toBe(false);
		const controller = new AbortController();
		const result = runProcess(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)"],
			process.cwd(),
			controller.signal,
		);
		controller.abort();
		expect(await result).toEqual({ success: false, result: "Background execution cancelled." });
	});
});
