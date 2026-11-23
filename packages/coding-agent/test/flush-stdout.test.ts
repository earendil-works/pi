import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushStdout } from "../src/utils/flush-stdout.ts";

// #12133: process.exit() dropped queued terminal mode resets; exits now wait for stdout first.
describe("flushStdout", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("resolves once stdout has written the output queued before it", async () => {
		const callbacks: Array<() => void> = [];
		vi.spyOn(process.stdout, "write").mockImplementation(((_chunk: string, callback: () => void) => {
			callbacks.push(callback);
			return false;
		}) as typeof process.stdout.write);
		let resolved = false;
		const flushed = flushStdout().then(() => {
			resolved = true;
		});
		await Promise.resolve();
		expect(resolved).toBe(false);
		callbacks[0]!();
		await flushed;
		expect(resolved).toBe(true);
	});

	it("resolves after the timeout when stdout never finishes writing", async () => {
		vi.useFakeTimers();
		vi.spyOn(process.stdout, "write").mockImplementation((() => false) as typeof process.stdout.write);
		let resolved = false;
		const flushed = flushStdout().then(() => {
			resolved = true;
		});
		await vi.advanceTimersByTimeAsync(999);
		expect(resolved).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await flushed;
		expect(resolved).toBe(true);
	});
});

describe("flushStdout before process.exit()", () => {
	const fixture = fileURLToPath(new URL("./fixtures/flush-stdout-exit.ts", import.meta.url));

	it("writes all queued output before exiting", async () => {
		// More than a pipe buffer holds, so on POSIX the child's write is still queued when it exits.
		const size = 4 * 1024 * 1024;
		const child = spawn(process.execPath, [fixture, String(size)], { stdio: ["ignore", "pipe", "inherit"] });
		let output = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			output += chunk;
		});
		const [code] = await once(child, "close");
		expect(code).toBe(0);
		expect(output.length).toBe(size + 3);
		expect(output.endsWith("END")).toBe(true);
	});

	it("exits cleanly when stdout is closed", async () => {
		const child = spawn(process.execPath, [fixture, "16"], { stdio: ["ignore", "pipe", "pipe"] });
		child.stdout.destroy();
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		const [code] = await once(child, "exit");
		expect(stderr).toBe("");
		expect(code).toBe(0);
	});
});
