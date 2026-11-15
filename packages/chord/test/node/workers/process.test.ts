// Tests of worker processes (slice 10 §3): forked with their output piped (the stderr tail kept), the link made at the
// fork (an early frame queued), control messages told, the whole tree killed, and the link closed at the exit before
// the exit is told.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FromWorker } from "../../../src/node/workers/control.ts";
import { WorkerProcess } from "../../../src/node/workers/process.ts";
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

	it("closes its link at its exit, before the exit is told, as neither a lost nor a closed link", async () => {
		const events: string[] = [];
		const child = new WorkerProcess(
			{
				entry: CHILD,
				execArgv: ["--conditions=source", "--experimental-strip-types", "--no-warnings"],
				onOutput: () => {},
			},
			{
				control: () => events.push("started"),
				linkLost: () => events.push("link lost"),
				linkClosed: () => events.push("link closed"),
				exited: () => events.push("exited"),
			},
		);
		child.link.onClose(() => events.push("closed"));
		await until(() => events.length > 0);
		// Only the leader ends: its grandchild holds the channel, which closes by itself only once the tree was killed,
		// at the exit.
		process.kill(child.pid, "SIGTERM");
		expect(await child.exited).toEqual({ code: null, signal: "SIGTERM" });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(events).toEqual(["started", "closed", "exited"]);
	});
});
