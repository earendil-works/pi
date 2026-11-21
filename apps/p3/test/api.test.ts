// p3's API module (`src/api/v1/index.ts`): `contribute`, an object that only contributes, with what a facet's own
// `self.contribute` cannot use; `until`, the first value of a watchable that passes; and `reportError`, which describes
// any value it is given in one line and never throws.

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
	until,
	type Writable,
	withAbortSignal,
	withCancel,
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

/** A registry summing its contributions: one writable count, set by the test. */
const Counts = defineRegistry<number, number>("test.counts", { version: 1 });

/** A host serving `Counts` with one contributed count, and that count. */
async function counted() {
	let count: Writable<number> | undefined;
	const host = createHost<P3Principal>({ onError: () => {} });
	const counting = defineFacet((host) => {
		host.serve(Counts, { compose: (table) => table.reduce((sum, { value }) => sum + value, 0) });
		contribute(host, "test.count", (self) => {
			count = self.writable(0);
			self.contribute(Counts, count);
		});
	});
	await host.load([{ name: "@test/until", facet: counting }], context);
	return { host, count: count!, counts: await host.registry(Counts, context) };
}

describe("until", () => {
	/** A deadline for a wait that should end: a failing case fails, never hangs. */
	const soon = () => withAbortSignal(AbortSignal.timeout(5000), context);

	it("resolves with the current value when it passes, else with the first later one that does", async () => {
		const { host, count, counts } = await counted();
		try {
			assert.equal(await until(counts, (n) => n === 0, soon()), 0);
			const later = until(counts, (n) => n >= 2, soon());
			count.set(1);
			count.set(2);
			assert.equal(await later, 2);
		} finally {
			await host.close(context);
		}
	});

	it("rejects with the context's reason when it aborts, and when the watch ends first", async () => {
		const { host, counts } = await counted();
		try {
			const { context: cancellable, cancel } = withCancel(soon());
			const aborted = until(counts, (n) => n > 0, cancellable);
			cancel(new Error("gave up"));
			await assert.rejects(aborted, /gave up/);
			const ended = until(counts, (n) => n > 0, soon());
			await host.close(context);
			await assert.rejects(ended, /until: the watch/);
		} finally {
			await host.close(context);
		}
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
		assert.match(printed(throwing), /p3 test: \[an unprintable object\]$/);
		assert.match(printed(Object.create(null)), /p3 test: \{\}$/);
		const chord = new ChordError({ code: "invalid", reason: "args", message: "no" }, { cause: 2n });
		assert.match(printed(chord), /invalid: no \(cause: 2\)$/);
	});

	// Astra, review round 3 (S6): the fallback read `Symbol.toStringTag`, so a value whose tag getter throws too threw
	// out of `reportError`.
	it("never runs a failing value's code again in its fallback", () => {
		const hostile = {
			get boom(): never {
				throw new Error("getter");
			},
			get [Symbol.toStringTag](): never {
				throw new Error("tag");
			},
		};
		assert.match(printed(hostile), /p3 test: \[an unprintable object\]$/);
	});

	// Opus, review round 3 (N6): a value referenced twice was shown as a cycle.
	it("shows a value referenced twice both times, and only a real cycle as one", () => {
		const shared = { n: 1 };
		const loop: { self?: unknown } = {};
		loop.self = loop;
		assert.match(
			printed({ a: shared, b: [shared], loop }),
			/\{"a":\{"n":1\},"b":\[\{"n":1\}\],"loop":\{"self":"\[cycle\]"\}\}$/,
		);
	});
});
