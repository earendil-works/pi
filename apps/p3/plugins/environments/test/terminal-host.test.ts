// The terminal host over a stand-in machine whose programs are fakes: an owner's list is replaced only when one of its
// terminals changes; an ended program's pseudo-terminal is released while its row and output stay; `next` waits for
// output and ends at the terminal's end; a close of the machine takes back an open under way; the host's end kills
// every program.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/p3/v1";
import type { MachineHost, Pty, PtyOptions } from "../contract.server.ts";
import { Terminals } from "../terminal-host.ts";

/** A fake program: its options, and whether it was closed. */
type Fake = { readonly options: PtyOptions; closed: boolean; exit(code: number): void };

/** A host over one stand-in machine `m1`; its programs in `started`, `gate` held back while set. */
function hosted() {
	const started: Fake[] = [];
	const state: { gate: Promise<void> | undefined } = { gate: undefined };
	const machine = {
		openPty: async (options: PtyOptions): Promise<Pty> => {
			await state.gate;
			let exited: (code: number) => void = () => {};
			const fake: Fake & Pty = {
				options,
				closed: false,
				exit: (code) => exited(code),
				write: () => {},
				resize: () => {},
				close: () => {
					fake.closed = true;
				},
				exited: new Promise((resolve) => {
					exited = resolve;
				}),
			};
			started.push(fake);
			return fake;
		},
	} as unknown as MachineHost;
	const terminals = new Terminals(() => (id) => (id === "m1" ? machine : undefined));
	return { terminals, started, state };
}

/** What `open` takes, for `owner`. */
const request = (owner: string) => ({
	owner,
	machine: "m1",
	folder: "/tmp",
	columns: 80,
	rows: 24,
	openedBy: { kind: "server" } as const,
	max: 20,
});

describe("the terminal host", () => {
	it("replaces an owner's list only when one of its terminals changes", async () => {
		const { terminals } = hosted();
		const seen: string[] = [];
		terminals.watch("a", () => seen.push("a"));
		await terminals.open(request("a"), context);
		const listA = terminals.list("a");
		const b = await terminals.open(request("b"), context);
		terminals.resize(b, 100, 30);
		assert.equal(terminals.list("a"), listA, "a change of b's leaves a's list");
		assert.deepEqual(seen, ["a"]);
	});

	it("releases an ended program's pseudo-terminal, keeps its row and output, and ends its readers", async () => {
		const { terminals, started } = hosted();
		const id = await terminals.open(request("a"), context);
		started[0]!.options.onData(new TextEncoder().encode("bye"));
		const waiting = terminals.next(id, 3, context);
		started[0]!.exit(0);
		assert.equal((await waiting).bytes.length, 0);
		assert.equal(started[0]!.closed, true);
		assert.equal(terminals.list("a")[0]!.exitCode, 0);
		assert.equal(Buffer.from(terminals.tail(id).bytes).toString(), "bye");
	});

	it("takes back an open under way when its machine closes, and kills every program at its end", async () => {
		const { terminals, started, state } = hosted();
		await terminals.open(request("a"), context);
		let go: () => void = () => {};
		state.gate = new Promise((resolve) => {
			go = resolve;
		});
		const pending = terminals.open(request("a"), context);
		terminals.closeMachine("m1");
		go();
		await assert.rejects(pending);
		assert.deepEqual(
			started.map((fake) => fake.closed),
			[true, true],
		);
		state.gate = undefined;
		await terminals.open(request("b"), context);
		terminals.end();
		assert.equal(started[2]!.closed, true);
		await assert.rejects(terminals.open(request("b"), context));
	});
});
