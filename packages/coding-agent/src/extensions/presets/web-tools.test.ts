import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { SpawnedProcess, SpawnFn } from "./spawn-cli.js";
import { createFetchTool, createWebSearchTool, type FetchArgs, type WebSearchArgs } from "./web-tools.js";

function makeFakeProcess(params: { stdout: string; stderr?: string; exitCode?: number }): SpawnedProcess {
	const stdout = new PassThrough();
	const stderr = new PassThrough();

	const listeners = {
		error: [] as Array<(err: Error) => void>,
		close: [] as Array<(code: number | null) => void>,
	};

	let proc: SpawnedProcess;
	proc = {
		stdout,
		stderr,
		kill: () => true,
		on: ((event: "close" | "error", handler: unknown) => {
			if (event === "close") {
				listeners.close.push(handler as (code: number | null) => void);
			} else {
				listeners.error.push(handler as (err: Error) => void);
			}
			return proc;
		}) as SpawnedProcess["on"],
	};

	queueMicrotask(() => {
		stdout.write(params.stdout);
		stdout.end();
		stderr.write(params.stderr ?? "");
		stderr.end();
		for (const cb of listeners.close) cb(params.exitCode ?? 0);
	});

	return proc;
}

describe("createWebSearchTool", () => {
	it("spawns websearch query with CLI-parity flags", async () => {
		const spawn: SpawnFn = vi.fn(() => makeFakeProcess({ stdout: "ok\n" }));
		const tool = createWebSearchTool({ spawn });

		const args: WebSearchArgs = {
			searchTerm: "hello world",
			country: "US",
			lang: "en-US",
			count: 3,
			offset: 10,
			freshness: "w1",
			batch: ["one", "two"],
		};

		const res = await tool.execute("toolcall-1", args);

		expect(spawn).toHaveBeenCalledWith(
			"websearch",
			[
				"query",
				"hello world",
				"--country",
				"US",
				"--lang",
				"en-US",
				"--count",
				"3",
				"--offset",
				"10",
				"--freshness",
				"w1",
				"--batch",
				"one",
				"two",
			],
			expect.any(Object),
		);

		expect(res.content[0]).toEqual({ type: "text", text: "ok\n" });

		expect(res.details.mu_display?.version).toBe(1);
		expect(res.details.mu_display?.call?.text).toContain("websearch query");
		expect(res.details.mu_display?.summary?.text).toContain("ok · exit=0");
	});
});

describe("createFetchTool", () => {
	it("spawns webfetch with CLI-parity flags and parses next= from stderr", async () => {
		const stderr = "[webfetch] MISS BROWSER 200 https://example.com/ len=167 slice=0-167 next=167\n";
		const spawn: SpawnFn = vi.fn(() => makeFakeProcess({ stdout: "CONTENT\n", stderr }));
		const tool = createFetchTool({ spawn });

		const args: FetchArgs = {
			url: "https://example.com",
			browser: true,
			maxLength: 200,
			startIndex: 10,
		};

		const res = await tool.execute("toolcall-2", args);

		expect(spawn).toHaveBeenCalledWith(
			"webfetch",
			["https://example.com", "--browser", "--max-length", "200", "--start-index", "10"],
			expect.any(Object),
		);

		expect(res.content[0]).toEqual({ type: "text", text: "CONTENT\n" });
		expect(res.details.nextStart).toBe(167);
		expect(res.details.mu_display?.version).toBe(1);
		expect(res.details.mu_display?.call?.text).toContain("webfetch https://example.com");
		expect(res.details.mu_display?.call?.text).toContain("--browser");
		expect(res.details.mu_display?.call?.text).toContain("--max-length 200");
		expect(res.details.mu_display?.call?.text).toContain("--start-index 10");
		expect(res.details.mu_display?.summary?.text).toContain("next=167");
	});
});
