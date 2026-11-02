// Tests of the worker's side (slice 10 §3): the start message, the lock, `started` on `connect`, `ready`; shutdown
// during startup, the parent's disconnect and SIGTERM each run the closers and exit; `fatal` redacted.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hostKind, str } from "../../../src/next/contracts/index.ts";
import type { FromWorker } from "../../../src/next-node/workers/control.ts";
import { type Exit, WorkerProcess } from "../../../src/next-node/workers/process.ts";
import type { WorkerBehaviour } from "../fixtures/workers/control.ts";
import { until } from "./support.ts";

const ENTRY = fileURLToPath(new URL("../fixtures/workers/worker.ts", import.meta.url));

const Session = hostKind("session", { id: str() });

/** The fixture worker forked and started with `behaviour`; its control messages and exit collected. */
function started(behaviour: WorkerBehaviour) {
	const control: FromWorker[] = [];
	let exit: Exit | undefined;
	const child = new WorkerProcess(
		{
			entry: ENTRY,
			execArgv: ["--conditions=source", "--experimental-strip-types", "--no-warnings"],
			onOutput: () => {},
		},
		{
			control: (message) => control.push(message),
			linkLost: () => {},
			linkClosed: () => {},
			exited: (value) => {
				exit = value;
			},
		},
	);
	child.send({
		kind: "start",
		address: Session({ id: "S1" }),
		start: behaviour,
		scripts: [],
		lock: `chord-test-main:${process.pid}:${Date.now()}:${Math.random()}`,
	});
	return { child, control, exited: () => exit };
}

describe("the worker's side", () => {
	it("sends started when the app connects, then ready with its load report and idle state", async () => {
		const { child, control } = started({});
		await until(() => control.some(({ kind }) => kind === "ready"));
		expect(control.map(({ kind }) => kind)).toEqual(["started", "ready"]);
		expect(control[1]).toMatchObject({ idle: true, report: { plugins: { added: [] }, failed: [] } });
		child.kill();
	});

	it("shuts down during its startup: aborts it, runs the closers registered so far in reverse order, exits 0", async () => {
		const dir = await mkdtemp(join(tmpdir(), "chord-main-"));
		const { child, control, exited } = started({ hang: true, log: join(dir, "log") });
		await until(() => control.some(({ kind }) => kind === "started"));
		child.send({ kind: "shutdown" });
		await until(() => exited() !== undefined);
		expect(exited()).toEqual({ code: 0, signal: null });
		expect(await readFile(join(dir, "log"), "utf8")).toBe("store\nhost\n");
		await rm(dir, { recursive: true, force: true });
	});

	it("shuts down on SIGTERM and on the parent's disconnect", async () => {
		const term = started({});
		await until(() => term.control.some(({ kind }) => kind === "ready"));
		process.kill(term.child.pid, "SIGTERM");
		await until(() => term.exited() !== undefined);
		expect(term.exited()).toEqual({ code: 0, signal: null });
		const gone = started({});
		await until(() => gone.control.some(({ kind }) => kind === "ready"));
		gone.child.link.close();
		await until(() => gone.exited() !== undefined);
		expect(gone.exited()).toEqual({ code: 0, signal: null });
	});

	it("sends fatal with the redacted error and exits 1", async () => {
		const { control, exited } = started({ fatal: "no secret-key-42 here" });
		await until(() => exited() !== undefined);
		expect(control).toEqual([{ kind: "fatal", error: { message: "no [redacted] here" } }]);
		expect(exited()?.code).toBe(1);
	});
});
