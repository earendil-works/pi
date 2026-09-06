import { describe, expect, test } from "vitest";
import { runClipboardCommand } from "../src/utils/clipboard-command.ts";

describe("clipboard commands", () => {
	test("preserves binary output and distinguishes empty success from failure", async () => {
		expect(
			await runClipboardCommand(process.execPath, ["-e", "process.stdout.write(Buffer.from([0, 255, 10]))"]),
		).toEqual(Buffer.from([0, 255, 10]));
		expect(await runClipboardCommand(process.execPath, ["-e", ""])).toEqual(Buffer.alloc(0));
		expect(await runClipboardCommand(process.execPath, ["-e", "process.exit(1)"])).toBeUndefined();
		expect(await runClipboardCommand("pi-clipboard-command-does-not-exist", [])).toBeUndefined();
	});
	test("sends Unicode input to clipboard writers", async () => {
		const script =
			"let text = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => text += c); process.stdin.on('end', () => process.exit(text === 'café 日本語' ? 0 : 1));";
		expect(await runClipboardCommand(process.execPath, ["-e", script], { input: "café 日本語" })).toEqual(
			Buffer.alloc(0),
		);
	});
	test("times out without blocking the event loop", async () => {
		let ticks = 0;
		const timer = setInterval(() => ticks++, 10);
		try {
			expect(
				await runClipboardCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 200 }),
			).toBeUndefined();
			expect(ticks).toBeGreaterThan(5);
		} finally {
			clearInterval(timer);
		}
	});
	test("rejects output above the buffer limit", async () => {
		expect(
			await runClipboardCommand(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(1024))"], {
				maxBufferBytes: 16,
			}),
		).toBeUndefined();
	});
});
