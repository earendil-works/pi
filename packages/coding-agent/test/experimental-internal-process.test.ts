import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { spawnInternalProcess, terminateInternalProcess } from "../src/experimental/process.ts";

const children = new Set<ChildProcess>();
const directories = new Set<string>();

afterEach(async () => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGTERM");
			await exited;
		}
	}
	children.clear();
	await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
	directories.clear();
});

describe.skipIf(process.platform === "win32")("experimental internal process launcher", () => {
	test("starts the coordinator through the current runtime", async () => {
		// Keep Unix socket paths below macOS's short sun_path limit.
		const directory = await mkdtemp(join(tmpdir(), "pi-ip-"));
		directories.add(directory);
		const publicPath = join(directory, "p.sock");
		const controlPath = join(directory, "c.sock");
		const child = spawnInternalProcess("coordinator", [publicPath, controlPath]);
		children.add(child);

		await expect.poll(() => canConnect(controlPath), { timeout: 10_000 }).toBe(true);
		expect(child.pid).not.toBe(process.pid);
	});

	test("waits for a failed activation child to terminate", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-ip-stop-"));
		directories.add(directory);
		const child = spawnInternalProcess("coordinator", [join(directory, "p.sock"), join(directory, "c.sock")]);
		children.add(child);

		await expect.poll(() => child.pid).toEqual(expect.any(Number));
		await terminateInternalProcess(child);
		expect(child.signalCode).toBe("SIGKILL");
	});
});

function canConnect(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(path);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}
