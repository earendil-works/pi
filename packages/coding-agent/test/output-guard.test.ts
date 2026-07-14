import { afterEach, describe, expect, it } from "vitest";
import { restoreStdout, takeOverStdout, withStdoutRedirectHandler } from "../src/core/output-guard.ts";

afterEach(() => {
	restoreStdout();
});

describe("non-interactive stdout guard", () => {
	it("lets a bounded async context route stdout before stderr fallback", async () => {
		const originalStderrWrite = process.stderr.write;
		const stderrWrites: string[] = [];
		const captured: string[] = [];

		process.stderr.write = ((chunk: string | Uint8Array) => {
			stderrWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
			return true;
		}) as typeof process.stderr.write;

		try {
			takeOverStdout();
			await withStdoutRedirectHandler(
				(text) => {
					captured.push(text);
					return true;
				},
				async () => {
					await Promise.resolve();
					process.stdout.write("structured\n");
				},
			);
			process.stdout.write("diagnostic\n");
		} finally {
			restoreStdout();
			process.stderr.write = originalStderrWrite;
		}

		expect(captured).toEqual(["structured\n"]);
		expect(stderrWrites).toEqual(["diagnostic\n"]);
	});

	it("keeps overlapping async contexts independently correlated", async () => {
		const originalStderrWrite = process.stderr.write;
		const first: string[] = [];
		const second: string[] = [];

		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			takeOverStdout();
			await Promise.all([
				withStdoutRedirectHandler(
					(text) => {
						first.push(text);
						return true;
					},
					async () => {
						await new Promise((resolve) => setTimeout(resolve, 10));
						process.stdout.write("first\n");
					},
				),
				withStdoutRedirectHandler(
					(text) => {
						second.push(text);
						return true;
					},
					async () => {
						await Promise.resolve();
						process.stdout.write("second\n");
					},
				),
			]);
		} finally {
			restoreStdout();
			process.stderr.write = originalStderrWrite;
		}

		expect(first).toEqual(["first\n"]);
		expect(second).toEqual(["second\n"]);
	});
});
