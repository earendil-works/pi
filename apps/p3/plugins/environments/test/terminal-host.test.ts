// The terminal host over a stand-in machine whose programs are fakes: an owner's list is replaced only when one of its
// terminals starts, ends or closes (a resize changes no row); an ended program's pseudo-terminal is released while its
// row and output stay, it takes typing no more and frees its slot; `next` waits for output and ends at the terminal's
// end; `tail` answers at most what is asked; an open under way is taken back by its caller, the machine's, the owner's
// and the host's end, and a program that came late is closed, never listed; the host's end kills every program.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Context, BACKGROUND_CONTEXT as context, withCancel } from "@earendil-works/p3/v1";
import type { MachineHost, PtyOptions } from "../contract.server.ts";
import { HostedTerminals } from "../terminal-host.ts";
import { fakeMachine } from "./fake-machine.ts";

/** A host over one stand-in machine `m1`. */
function hosted() {
	const machine = fakeMachine();
	const terminals = new HostedTerminals(() => async (id) => (id === "m1" ? machine.host : undefined));
	return { terminals, machine };
}

/** What `open` takes, for `owner`, at most `max` of the owner's running. */
const request = (owner: string, max = 20) => ({ owner, machine: "m1", folder: "/tmp", columns: 80, rows: 24, max });

/** Waits until what was started has run up to its next wait (an open into the machine's gate). */
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Holds `machine`'s `openPty` back until the answered function is called. */
function gated(machine: ReturnType<typeof fakeMachine>): () => void {
	const gate = Promise.withResolvers<void>();
	machine.gate = gate.promise;
	return () => gate.resolve();
}

describe("the terminal host", () => {
	it("replaces an owner's list only when one of its terminals starts, ends or closes; a resize changes none", async () => {
		const { terminals, machine } = hosted();
		const seen: string[] = [];
		terminals.watch("a", () => seen.push("a"));
		const a = await terminals.open(request("a"), context);
		const listA = terminals.list("a");
		const b = await terminals.open(request("b"), context);
		terminals.resize(b, 100, 30);
		terminals.resize(a, 100, 30);
		assert.deepEqual(machine.started[0]!.size, [100, 30]);
		assert.equal(terminals.list("a"), listA, "neither b's change nor a resize replaces a's list");
		assert.deepEqual(seen, ["a"]);
	});

	it("releases an ended program's pseudo-terminal, keeps its row and output, ends its readers, takes no typing", async () => {
		const { terminals, machine } = hosted();
		const id = await terminals.open(request("a"), context);
		machine.started[0]!.say("bye");
		assert.equal(terminals.write(id, "x"), true);
		const waiting = terminals.next(id, 3, context);
		machine.started[0]!.exit(0);
		assert.equal((await waiting).bytes.length, 0);
		assert.equal(machine.started[0]!.closed, true);
		assert.equal(terminals.list("a")[0]!.exitCode, 0);
		assert.equal(Buffer.from(terminals.tail(id, 1024).bytes).toString(), "bye");
		assert.equal(terminals.write(id, "y"), false, "an ended program answers that it did not get it");
		assert.deepEqual(machine.started[0]!.typed, ["x"]);
	});

	it("counts only running programs against the bounds (opus round 2, S2)", async () => {
		const { terminals, machine } = hosted();
		await terminals.open(request("a", 1), context);
		await assert.rejects(terminals.open(request("a", 1), context), /too many/);
		machine.started[0]!.exit(0);
		await settled();
		await terminals.open(request("a", 1), context);
		assert.deepEqual(terminals.owners(), ["a"]);
		assert.equal(terminals.list("a").length, 2, "the ended one is still listed");
	});

	it("answers at most the asked tail of the kept output (opus round 2, S1)", async () => {
		const { terminals, machine } = hosted();
		const id = await terminals.open(request("a"), context);
		machine.started[0]!.say("0123456789");
		const tail = terminals.tail(id, 4);
		assert.deepEqual([Buffer.from(tail.bytes).toString(), tail.end], ["6789", 10]);
	});

	it("takes back an open under way when its machine or its owner closes, and kills every program at its end", async () => {
		const { terminals, machine } = hosted();
		await terminals.open(request("a"), context);
		let go = gated(machine);
		const byMachine = terminals.open(request("a"), context);
		await settled();
		terminals.closeMachine("m1");
		go();
		await assert.rejects(byMachine);
		go = gated(machine);
		const byOwner = terminals.open(request("ab"), context);
		await settled();
		terminals.closeOwners("a");
		go();
		await assert.rejects(byOwner);
		assert.deepEqual(
			machine.started.map((fake) => fake.closed),
			[true, true, true],
			"the late programs are closed",
		);
		assert.deepEqual(terminals.owners(), []);
		machine.gate = undefined;
		await terminals.open(request("b"), context);
		terminals.end();
		assert.equal(machine.started[3]!.closed, true);
		await assert.rejects(terminals.open(request("b"), context));
	});

	it("never publishes a program that came after its caller cancelled (astra round 2)", async () => {
		const { terminals, machine } = hosted();
		const go = gated(machine);
		const { cancel, context: call } = withCancel(context);
		try {
			const entering = terminals.open(request("a"), call);
			await settled();
			cancel();
			go();
			await assert.rejects(entering);
			assert.deepEqual(terminals.list("a"), []);
			assert.equal(
				machine.started.every((program) => program.closed),
				true,
			);
		} finally {
			terminals.end();
		}
	});

	it("signals a pending start when the host ends, so the machine can let go of it (astra round 2)", async () => {
		let startup: AbortSignal | undefined;
		const wait = Promise.withResolvers<never>();
		const machine = {
			openPty: (_options: PtyOptions, ctx: Context) => {
				startup = ctx.abortSignal;
				startup?.addEventListener("abort", () => wait.reject(new Error("aborted")), { once: true });
				return wait.promise;
			},
		} as unknown as MachineHost;
		const host = new HostedTerminals(() => async () => machine);
		const pending = host.open(request("a"), context).catch(() => {});
		await settled();
		host.end();
		assert.equal(startup?.aborted, true);
		await pending;
	});

	it("never writes a list or a row it handed out (guide 8.12)", async () => {
		const { terminals, machine } = hosted();
		const handed: unknown[] = [];
		const freeze = (rows: readonly unknown[]) => {
			for (const row of rows) Object.freeze(row);
			handed.push(Object.freeze(rows));
		};
		terminals.watch("a", freeze);
		const one = await terminals.open(request("a"), context);
		const two = await terminals.open(request("a"), context);
		freeze(terminals.list("a"));
		const copies = handed.map((rows) => structuredClone(rows));
		terminals.resize(one, 90, 30);
		machine.started[0]!.exit(1);
		await settled();
		terminals.close(two);
		terminals.closeOwners("a");
		assert.deepEqual(handed.slice(0, copies.length), copies, "what was handed out is as it was");
	});
});
