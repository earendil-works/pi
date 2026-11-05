import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { spawnProcessTree } from "../src/utils/shell.ts";

// A command that starts a background node process, prints its pid, and then exits or keeps running. On Unix the
// background process must not be detached (setsid would move it out of the process group). On Windows it must be:
// libuv puts non-detached children into a job of the command's own that kills them when the command exits, which
// shells such as Git Bash do not do. Detached Windows processes still stay in pi's job object.
function backgroundScript(then: "exit 3" | "stay"): string {
	return [
		'const { spawn } = require("node:child_process");',
		'const options = { stdio: "ignore", detached: process.platform === "win32" };',
		'const background = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);',
		"background.unref();",
		'process.stdout.write(background.pid + "\\n");',
		then === "exit 3" ? "process.exit(3);" : "setInterval(() => {}, 1000);",
	].join("\n");
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntil(condition: () => boolean, timeoutMs = 10_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return condition();
}

function readFirstLine(child: ChildProcess): Promise<string> {
	return new Promise((resolve, reject) => {
		let output = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			const newline = output.indexOf("\n");
			if (newline >= 0) resolve(output.slice(0, newline).trim());
		});
		child.once("error", reject);
	});
}

function waitForExit(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

describe("spawnProcessTree", () => {
	it("passes arguments through unchanged and reports the command's exit code", async () => {
		const args = ["a b", 'q"uote', "trailing\\", "", "%PATH%"];
		const tree = spawnProcessTree(
			process.execPath,
			["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1))); process.exit(7)", ...args],
			{ stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
		);
		let output = "";
		tree.child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		expect(await waitForExit(tree.child)).toBe(7);
		expect(JSON.parse(output)).toEqual(args);
	});

	// #11613: Windows could not kill background processes once the shell had exited.
	it("leaves background processes running after the command exits and kills them later", async () => {
		const tree = spawnProcessTree(process.execPath, ["-e", backgroundScript("exit 3")], {
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		});
		const exit = waitForExit(tree.child);
		const backgroundPid = Number(await readFirstLine(tree.child));
		expect(await exit).toBe(3);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(isAlive(backgroundPid)).toBe(true);

		tree.kill();
		expect(await waitUntil(() => !isAlive(backgroundPid))).toBe(true);
	});

	it("kills the command and its background processes while the command runs", async () => {
		const tree = spawnProcessTree(process.execPath, ["-e", backgroundScript("stay")], {
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		});
		const exit = waitForExit(tree.child);
		const backgroundPid = Number(await readFirstLine(tree.child));
		expect(isAlive(backgroundPid)).toBe(true);

		tree.kill();
		await exit;
		expect(await waitUntil(() => !isAlive(backgroundPid))).toBe(true);
	});
});
