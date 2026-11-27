// This device's host (this-device.ts), as the machine kind's one thing in Pi connects to it: a bounded listing stops
// when its caller goes; a staged file is 0600 under a name of its own, and its landing and its removal have one owner
// (a landing once called has won; a discard after it removes nothing); a crash's staged file is removed only while the
// file at its path is still that one (astra round 3). Its terminals run the user's shell in pi-env's daemon (decision
// 133): output, typing, a size the shell sees, the exit code; a close kills the program; a folder that does not exist
// is refused; the connection's close stops the daemon, and its programs with it.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, type P3Principal, withCancel } from "@earendil-works/p3/v1";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import peopleServer from "../../people/server.ts";
import { OneThing } from "../../things/contract.server.ts";
import thingsServer from "../../things/server.ts";
import { type MachineHost, MachineHosts, MachineTypes, type Pty, type StagedFile } from "../contract.server.ts";
import { MACHINE_KIND, THIS_DEVICE_TYPE } from "../contract.ts";
import { seeded } from "./seeded.ts";

describe("this device's host", () => {
	let t: TestedPlugin<P3Principal>;
	let at: MachineHost;
	let root: string;

	before(async () => {
		const stubs = [
			{ name: "@earendil-works/p3-people", facet: peopleServer },
			{ name: "@earendil-works/p3-things", facet: thingsServer },
		];
		t = await testPlugin(fileURLToPath(new URL("../", import.meta.url)), { kind: "server", stubs }, context);
		const machine = await seeded(await t.host.get(OneThing, { kind: MACHINE_KIND }, context), context);
		at = (await (await t.host.registry(MachineHosts, context)).value(machine, context))!;
		root = await mkdtemp(join(tmpdir(), "p3-this-device-"));
	});

	after(async () => {
		await t.close(context);
		await rm(root, { recursive: true, force: true });
	});

	/** A new staged file in the test's folder, with `text` written. */
	async function staged(text: string): Promise<StagedFile> {
		const made = await at.stageFile(root, context);
		assert.ok(made.ok);
		assert.ok((await made.value.write(Buffer.from(text), context)).ok);
		return made.value;
	}

	it("stops a bounded listing when its caller goes (astra round 3)", async () => {
		const many = join(root, "many");
		await mkdir(many);
		await Promise.all(Array.from({ length: 3000 }, (_, i) => writeFile(join(many, `f${i}`), "")));
		const { context: call, cancel } = withCancel(context);
		cancel(new Error("gone"));
		assert.equal((await at.listNames(many, 10_000, call)).ok, false);
		const listed = await at.listNames(many, 10, context);
		assert.ok(listed.ok);
		assert.deepEqual([listed.value.names.length, listed.value.more], [10, true]);
		await rm(many, { recursive: true });
	});

	it("lands a staged file once its landing was called, whatever a discard after it asks (astra round 3, must 1)", async () => {
		const file = await staged("landed");
		const target = join(root, "target");
		const landing = file.publish(target, context);
		const discard = file.discard(context);
		assert.deepEqual(await landing, { ok: true, value: undefined });
		assert.deepEqual(await discard, { ok: true, value: "landed" });
		assert.equal(await readFile(target, "utf8"), "landed");
		assert.equal((await file.publish(join(root, "again"), context)).ok, false, "settled once");
	});

	it("refuses a landing after a discard, and removes what a failed landing left", async () => {
		const discarded = await staged("x");
		assert.deepEqual(await discarded.discard(context), { ok: true, value: "removed" });
		assert.equal((await discarded.publish(join(root, "no"), context)).ok, false);
		const failing = await staged("y");
		assert.equal((await failing.publish(join(root, "missing", "target"), context)).ok, false);
		assert.deepEqual(await failing.discard(context), { ok: true, value: "removed" });
		assert.deepEqual(
			(await readdir(root)).filter((name) => name.startsWith(".p3-upload-")),
			[],
		);
	});

	it("removes a crash's staged file only while it is still that file (astra round 3, must 3)", async () => {
		// A file that took a staged file's place (made while the staged file still was: another inode).
		const gone = await staged("partial");
		const other = join(root, "other");
		await writeFile(other, "someone else's file");
		await gone.discard(context);
		await rename(other, gone.path);
		assert.deepEqual(await at.removeStaged(gone.path, gone.identity, context), { ok: true, value: "absent" });
		assert.equal(await readFile(gone.path, "utf8"), "someone else's file");
		await rm(gone.path);
		// The staged file itself (as a crash leaves it: written, never landed).
		const left = await staged("left");
		assert.deepEqual(await at.removeStaged(left.path, left.identity, context), { ok: true, value: "removed" });
		assert.equal((await left.discard(context)).ok, false, "nothing left to discard");
	});

	it("answers concurrent removals of one staged file once removed, else absent (astra round 4)", async () => {
		const left = await staged("left");
		const answers = await Promise.all([1, 2, 3].map(() => at.removeStaged(left.path, left.identity, context)));
		assert.deepEqual(answers.map((answer) => (answer.ok ? answer.value : answer.error.code)).sort(), [
			"absent",
			"absent",
			"removed",
		]);
		await left.discard(context);
	});

	it("closes a new staged file whose identity cannot be read (astra round 4, must 2)", async () => {
		const probe = await open(join(root, "probe"), "w");
		const prototype = Object.getPrototypeOf(probe) as { stat: (...args: unknown[]) => Promise<unknown> };
		await probe.close();
		const stat = prototype.stat;
		const opened = async () => (await readdir("/proc/self/fd")).length;
		const before = await opened();
		prototype.stat = async () => {
			throw new Error("metadata I/O");
		};
		try {
			assert.equal((await at.stageFile(root, context)).ok, false);
		} finally {
			prototype.stat = stat;
		}
		assert.equal(await opened(), before, "no descriptor left open");
		await rm(join(root, "probe"));
	});

	describe("its terminals", () => {
		/** A shell in `folder` on `host`, its output so far, and `printed`, which waits for `pattern` in it. */
		async function shell(host: MachineHost, folder: string) {
			let output = "";
			let seen: () => void = () => {};
			const opened = await host.openPty(
				{
					cwd: folder,
					columns: 80,
					rows: 24,
					onData: (bytes) => {
						output += Buffer.from(bytes).toString();
						seen();
					},
				},
				context,
			);
			assert.ok(opened.ok, opened.ok ? "" : opened.error.message);
			const printed = async (pattern: RegExp) => {
				const deadline = Date.now() + 10_000;
				while (!pattern.test(output)) {
					assert.ok(Date.now() < deadline, `no ${pattern} in ${JSON.stringify(output)}`);
					// The next output, or a look at the deadline.
					await new Promise<void>((resolve) => {
						seen = resolve;
						setTimeout(resolve, 1_000);
					});
				}
			};
			return { pty: opened.value as Pty, printed };
		}

		it("runs the shell: typed into, sized, its exit code", async () => {
			const { pty, printed } = await shell(at, root);
			pty.write("echo here-$((6*7)) && pwd\r");
			await printed(/here-42/);
			await printed(new RegExp(root));
			pty.resize(100, 30);
			pty.write(new TextEncoder().encode("stty size; exit 3\r"));
			await printed(/30 100/);
			assert.equal(await pty.exited, 3);
		});

		it("kills the program on close; refuses a folder that does not exist", async () => {
			const { pty, printed } = await shell(at, root);
			pty.write("echo up\r");
			await printed(/up/);
			pty.close();
			assert.equal(await pty.exited, -1);
			const missing = await at.openPty(
				{ cwd: join(root, "missing"), columns: 80, rows: 24, onData: () => {} },
				context,
			);
			assert.match(missing.ok ? "opened" : missing.error.message, /does not exist/);
		});

		// Astra, round 1, M2: a shell's background job (a group of its own) outlived the terminal's close.
		for (const end of ["the terminal's close", "the connection's close"]) {
			it(`ends a shell's background jobs with ${end}`, async () => {
				const host = await (await t.host.registry(MachineTypes, context)).value
					.get(THIS_DEVICE_TYPE)!
					.value.connect({}, context);
				const marker = join(root, end === "the terminal's close" ? "job-terminal" : "job-connection");
				try {
					const { pty, printed } = await shell(host, root);
					// A finite job: no nohup, disown, session change or trap; its file says whether it ran on.
					pty.write(`(sleep 0.6; echo finished > ${marker}) & echo started-$((6*7))\r`);
					await printed(/started-42/);
					if (end === "the terminal's close") pty.close();
					else await host.close(context);
					await pty.exited;
					// Longer than the job would have taken.
					await new Promise((resolve) => setTimeout(resolve, 1_000));
					assert.equal(
						await readFile(marker, "utf8").catch(() => "absent"),
						"absent",
						"the job ended with its terminal",
					);
				} finally {
					await host.close(context);
				}
			});
		}

		// Astra, round 2, M1: a job outlived a shell that exited on its own (the daemon reaped it, then forgot the session).
		it("ends a shell's background jobs when the shell exits on its own, keeping its exit code", async () => {
			const marker = join(root, "job-exit");
			const { pty } = await shell(at, root);
			pty.write(`(sleep 0.6; echo finished > ${marker}) & exit 7\r`);
			assert.equal(await pty.exited, 7);
			// Longer than the job would have taken.
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			assert.equal(await readFile(marker, "utf8").catch(() => "absent"), "absent", "the job ended with its shell");
		});

		it("ends its programs with the connection's close", async () => {
			const types = await t.host.registry(MachineTypes, context);
			const host = await types.value.get(THIS_DEVICE_TYPE)!.value.connect({}, context);
			const { pty, printed } = await shell(host, root);
			pty.write("echo up\r");
			await printed(/up/);
			await host.close(context);
			assert.equal(await pty.exited, -1);
		});
	});
});
