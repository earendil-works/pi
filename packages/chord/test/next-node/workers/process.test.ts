// Tests of worker processes (slice 10 §3): forked with their output piped (the stderr tail kept), the link made at the
// fork (an early frame queued), control messages told, and the whole tree killed.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FromWorker } from "../../../src/next-node/workers/control.ts";
import { WorkerProcess } from "../../../src/next-node/workers/process.ts";
import { until } from "./support.ts";

const CHILD = fileURLToPath(new URL("../fixtures/workers/child.ts", import.meta.url));

/** Whether process `pid` lives. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("a worker process", () => {
	it("pipes its output, keeps its stderr tail, queues an early frame on its link, tells control messages", async () => {
		const output: string[] = [];
		const control: FromWorker[] = [];
		const child = new WorkerProcess(
			{
				entry: CHILD,
				execArgv: ["--conditions=source", "--experimental-strip-types", "--no-warnings"],
				onOutput: (stream, chunk) => output.push(`${stream}: ${Buffer.from(chunk).toString().trim()}`),
			},
			{ control: (message) => control.push(message), linkLost: () => {}, linkClosed: () => {}, exited: () => {} },
		);
		await until(() => control.length > 0 && output.length >= 2);
		const frames: number[][] = [];
		child.link.onMessage((message) => frames.push([...message]));
		expect(frames).toEqual([[1, 2, 3]]);
		expect(control).toEqual([{ kind: "started" }]);
		expect(child.stderrTail).toBe("an error line\n");
		const grandchild = Number(/grandchild (\d+)/.exec(output.join("\n"))![1]);
		expect(alive(grandchild)).toBe(true);
		child.kill();
		expect(await child.exited).toEqual({ code: null, signal: "SIGKILL" });
		await until(() => !alive(grandchild), 2_000);
	});
});
