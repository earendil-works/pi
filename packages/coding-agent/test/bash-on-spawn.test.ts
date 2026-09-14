/**
 * The shell's pid is handed back to the caller that asked for it.
 *
 * A host that starts commands on behalf of a user (a headless server, a
 * desktop app measuring its own process tree) can otherwise only guess which
 * of its descendants a command is. `onSpawn` is observation and nothing else:
 * it is called once, it cannot change how the command runs, and a callback
 * that throws is ignored.
 */
import { describe, expect, it } from "vitest";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";

describe("bash operations: onSpawn", () => {
	it("reports the shell's pid once, before the command ends", async () => {
		const operations = createLocalBashOperations();
		const pids: number[] = [];
		let output = "";
		const result = await operations.exec("printf hello", process.cwd(), {
			onData: (data) => {
				output += data.toString("utf8");
			},
			onSpawn: (pid) => pids.push(pid),
		});
		expect(result.exitCode).toBe(0);
		expect(output).toBe("hello");
		expect(pids).toHaveLength(1);
		expect(pids[0]).toBeGreaterThan(0);
		expect(pids[0]).not.toBe(process.pid);
	});

	it("runs the command normally when the observer throws, and when there is none", async () => {
		const operations = createLocalBashOperations();
		let output = "";
		const thrown = await operations.exec("printf one", process.cwd(), {
			onData: (data) => {
				output += data.toString("utf8");
			},
			onSpawn: () => {
				throw new Error("observer failure");
			},
		});
		expect(thrown.exitCode).toBe(0);
		expect(output).toBe("one");

		const plain = await operations.exec("printf two", process.cwd(), {
			onData: (data) => {
				output += data.toString("utf8");
			},
		});
		expect(plain.exitCode).toBe(0);
		expect(output).toBe("onetwo");
	});
});
