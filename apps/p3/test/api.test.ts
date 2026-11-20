// p3's API module (`src/api/v1/index.ts`): `contribute`, an object that only contributes, with what a facet's own
// `self.contribute` cannot use; and `reportError`, which describes any value it is given in one line and never throws.

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { createHost } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	ChordError,
	constant,
	contribute,
	defineFacet,
	defineRegistry,
	local,
	type P3Principal,
	reportError,
	str,
} from "@earendil-works/p3/v1";

/** A registry of greetings, composed into one list. */
const Greetings = defineRegistry<string, readonly string[]>("test.greetings", { version: 1 });

const Names = local("test.names", { version: 1, params: {}, members: { name: str() } });

const facet = defineFacet((host) => {
	host.serve(Greetings, { compose: (table) => table.map(({ value }) => value) });
	host.serve(Names, () => ({ name: constant("Pi") }));
	// The contribution follows another object's state: it needs a reference, so it needs an object.
	contribute(host, "test.greeter", (self) => {
		const names = self.get(Names, {});
		self.contribute(
			Greetings,
			self.derive([names.name], ([name]) => `hello ${name}`),
		);
	});
});

describe("contribute", () => {
	it("contributes from a host-lifetime object with no members", async () => {
		const host = createHost<P3Principal>({ onError: () => {} });
		await host.load([{ name: "@test/contribute", facet }], context);
		const greetings = await host.registry(Greetings, context);
		assert.deepEqual(greetings.value, ["hello Pi"]);
		await host.close(context);
	});
});

describe("reportError", () => {
	/** What `reportError` printed for `error`: one line on stderr. */
	const printed = (error: unknown): string => {
		const lines: string[] = [];
		const spy = mock.method(console, "error", (line: string) => void lines.push(line));
		try {
			reportError("p3 test", error, context);
		} finally {
			spy.mock.restore();
		}
		assert.equal(lines.length, 1);
		return lines[0]!;
	};

	it("prints a Chord error by its code, message and cause, and any other error with its stack", () => {
		const chord = new ChordError(
			{ code: "unavailable", reason: "storage_failed", message: "store: storage failed" },
			{ cause: new Error("disk full") },
		);
		assert.match(printed(chord), /p3 test: unavailable: store: storage failed \(cause: disk full\)$/);
		assert.match(printed(new TypeError("bad")), /p3 test: TypeError: bad\n\s+at /);
		assert.match(printed("plain"), /p3 test: plain$/);
	});

	it("prints a report object as JSON, its errors described", () => {
		const line = printed({
			kind: "worker",
			error: new ChordError({ code: "invalid", reason: "args", message: "no" }),
		});
		assert.match(line, /\{"kind":"worker","error":"invalid: no"\}$/);
	});

	// Sol, review round 2 (S4): a BigInt or a cyclic value threw past `reportError`, replacing the failure it reported.
	it("never throws: a BigInt, a cycle, a throwing getter, an object without a prototype", () => {
		const cyclic: { name: string; self?: unknown } = { name: "loop" };
		cyclic.self = cyclic;
		const throwing = {
			get boom(): never {
				throw new Error("getter");
			},
		};
		assert.match(printed({ records: 1n }), /\{"records":"1n"\}$/);
		assert.match(printed(1n), /p3 test: 1$/);
		assert.match(printed(cyclic), /\{"name":"loop","self":"\[cycle\]"\}$/);
		assert.match(printed(throwing), /p3 test: \[object Object\]$/);
		assert.match(printed(Object.create(null)), /p3 test: \{\}$/);
		const chord = new ChordError({ code: "invalid", reason: "args", message: "no" }, { cause: 2n });
		assert.match(printed(chord), /invalid: no \(cause: 2\)$/);
	});
});
