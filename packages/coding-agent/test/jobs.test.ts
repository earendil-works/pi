import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { JobManager } from "../src/core/jobs/manager.ts";
import { readJobRuntime, writeJobRecord } from "../src/core/jobs/state.ts";

const managers: JobManager[] = [];
const shell = { shell: process.execPath, args: ["--eval"] };
function catalog(): JobManager {
	const manager = new JobManager(mkdtempSync(join(tmpdir(), "pi-jobs-test-")));
	managers.push(manager);
	return manager;
}

afterEach(async () => {
	for (const manager of managers.splice(0)) {
		for (const job of await manager.list()) {
			if (job.runtime.state === "running") await manager.stop(job.id);
		}
		rmSync(manager.directory, { recursive: true, force: true });
	}
});

describe("persistent jobs", () => {
	// Supervisors run in separate OS processes; fake timers cannot drive their deadlines or pipe lifetimes.
	it("retains output after its starting process exits without persisting its environment", async () => {
		const manager = catalog();
		const release = join(manager.directory, "release");
		const command = `const fs = require('node:fs'); const release = ${JSON.stringify(release)}; console.log(process.env.PRIVATE_JOB_ENV); function check() { if (fs.existsSync(release)) { fs.unwatchFile(release); console.log('finished'); } } fs.watchFile(release, {interval:20}, check); check();`;
		const starter = spawnSync(
			process.execPath,
			[
				"--import",
				fileURLToPath(new URL("../src/experimental/source-resolver.ts", import.meta.url)),
				fileURLToPath(new URL("./fixtures/job-starter.mjs", import.meta.url)),
				manager.directory,
				command,
			],
			{ encoding: "utf8", timeout: 10000 },
		);
		expect(starter.error).toBeUndefined();
		expect(starter.status, starter.stderr).toBe(0);
		const id = starter.stdout.trim();
		expect((await manager.inspect(id)).runtime.state).toBe("running");
		const metadata = join(manager.directory, id, "spec.json");
		expect(readFileSync(metadata, "utf8")).not.toContain("not-persisted-secret");
		if (process.platform !== "win32") expect(statSync(metadata).mode & 0o777).toBe(0o600);
		writeFileSync(release, "go");
		await expect.poll(async () => (await manager.inspect(id)).runtime.state, { timeout: 10000 }).toBe("completed");
		expect(manager.logs(id).text).toBe("not-persisted-secret\nfinished\n");
	});

	it("stops, renames, restarts with a new identity, and deletes only the selected job", async () => {
		const manager = catalog();
		const first = await manager.start("console.log('original'); setInterval(() => {}, 1000)", manager.directory, {
			shell,
		});
		expect((await manager.rename(first.id, "renamed")).name).toBe("renamed");
		expect((await manager.stop(first.id)).runtime.state).toBe("stopped");
		const next = await manager.restart(first.id, "console.log('replacement')");
		expect(next.id).not.toBe(first.id);
		await expect.poll(async () => (await manager.inspect(next.id)).runtime.state).toBe("completed");
		expect(manager.logs(next.id).text).toBe("replacement\n");
		expect((await manager.inspect(first.id)).runtime.state).toBe("stopped");
		await manager.remove(first.id);
		await expect(manager.inspect(first.id)).rejects.toMatchObject({ code: "ENOENT" });
		expect(manager.logs(next.id).text).toBe("replacement\n");
	});

	it("enforces a job timeout independently of the starter", async () => {
		const manager = catalog();
		const job = await manager.start("setInterval(() => {}, 1000)", manager.directory, { shell, timeout: 0.05 });
		await expect.poll(async () => (await manager.inspect(job.id)).runtime.state).toBe("timed_out");
	});

	it("distinguishes command failure from launch acknowledgment and keeps its output", async () => {
		const manager = catalog();
		const job = await manager.start("console.log('failure details'); process.exitCode = 7", manager.directory, {
			shell,
		});
		await expect.poll(async () => (await manager.inspect(job.id)).runtime.state).toBe("failed");
		expect((await manager.inspect(job.id)).runtime).toMatchObject({ exitCode: 7 });
		expect(manager.logs(job.id).text).toBe("failure details\n");
	});

	it("shows only valid reported progress and rejects oversized reports without reading them", async () => {
		const manager = catalog();
		const job = await manager.start("setInterval(() => {}, 1000)", manager.directory, { shell });
		const directory = join(manager.directory, job.id);
		writeJobRecord(directory, "progress.json", { percent: 42, message: "indexing" });
		expect((await manager.inspect(job.id)).progress).toEqual({ percent: 42, message: "indexing" });
		writeFileSync(join(directory, "progress.json"), '{"percent":101}');
		expect(await manager.inspect(job.id)).toMatchObject({
			progressError: expect.stringContaining("Invalid progress"),
		});
		writeFileSync(join(directory, "progress.json"), "x".repeat(20000));
		const invalid = await manager.inspect(job.id);
		expect(invalid.progress).toBeUndefined();
		expect(invalid.progressError).toContain("exceeds 16384 bytes");
		expect(invalid.runtime.state).toBe("running");
	});

	it("does not trust a different server at the persisted control port", async () => {
		const manager = catalog();
		const job = await manager.start("setInterval(() => {}, 1000)", manager.directory, { shell });
		const directory = join(manager.directory, job.id);
		const runtime = readJobRuntime(directory);
		const server = createServer((socket) => {
			socket.on("error", () => {});
			socket.resume();
			socket.end(
				`${JSON.stringify({
					proof: "0".repeat(64),
					runtime: { state: "completed", startedAt: 0, endedAt: 1, exitCode: 0 },
				})}\n`,
			);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected local TCP server");
			if (runtime.state !== "running") throw new Error("Expected a running fixture");
			writeJobRecord(directory, "runtime.json", { ...runtime, port: address.port });
			expect((await manager.inspect(job.id)).runtime).toMatchObject({
				state: "unreachable",
				error: expect.stringContaining("authenticated"),
			});
		} finally {
			writeJobRecord(directory, "runtime.json", runtime);
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		expect((await manager.inspect(job.id)).runtime.state).toBe("running");
	});

	it("rejects oversized metadata before publishing an unusable catalog entry", async () => {
		const manager = catalog();
		await expect(manager.start("x".repeat(1024 * 1024), manager.directory, { shell })).rejects.toThrow("exceeds");
		expect(await manager.list()).toEqual([]);
	});

	it("resolves a relative catalog independently of the command's working directory", async () => {
		const manager = catalog();
		const relativeManager = new JobManager(relative(process.cwd(), manager.directory));
		const job = await relativeManager.start("console.log('relative catalog works')", tmpdir(), { shell });
		await expect.poll(async () => (await manager.inspect(job.id)).runtime.state).toBe("completed");
		expect(relativeManager.logs(job.id).text).toBe("relative catalog works\n");
	});

	it("keeps full logs while returning a bounded UTF-8 tail", async () => {
		const manager = catalog();
		const job = await manager.start("process.stdout.write('😀'.repeat(20000) + 'end\\n')", manager.directory, {
			shell,
		});
		await expect.poll(async () => (await manager.inspect(job.id)).runtime.state).toBe("completed");
		const tail = manager.logs(job.id);
		expect(tail.truncated).toBe(true);
		expect(tail.text).not.toContain("�");
		expect(tail.text.endsWith("end\n")).toBe(true);
		expect(Buffer.byteLength(tail.text)).toBeLessThanOrEqual(48 * 1024);
		expect(readFileSync(tail.path, "utf8")).toBe(`${"😀".repeat(20000)}end\n`);
	});
});
