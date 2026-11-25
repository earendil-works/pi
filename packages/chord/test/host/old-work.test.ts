// Tests of old work's bookkeeping (decision "Reload restarts every affected object; old work finishes on old code"):
// the call chain walk, its guard outside reloads, another host's old work, and the chain's attempts for reload cycles.
// The behaviour of old work in a reload is tested with the object (object.test.ts) and over links (provider.test.ts).

import { describe, expect, it } from "vitest";
import { type Context, BACKGROUND_CONTEXT as context, withContextValue } from "../../src/context/index.ts";
import {
	asRemoteOldWork,
	CALL_CHAIN,
	type CallNode,
	chainAttempts,
	OldWork,
	type OldWorkSource,
} from "../../src/host/old-work.ts";

/** A chain of nodes on `sources`, innermost first, and a count of the `up` steps taken through it. */
function chain(...sources: OldWorkSource[]): { readonly context: Context; readonly steps: () => number } {
	let steps = 0;
	let node: CallNode | undefined;
	for (const on of sources.toReversed()) {
		const up = node;
		node = {
			on,
			up: () => {
				steps++;
				return up;
			},
		};
	}
	return { context: node === undefined ? context : withContextValue(CALL_CHAIN, node, context), steps: () => steps };
}

describe("OldWork.of: whether a context runs under old work", () => {
	it("finds a draining attempt anywhere up the call chain", () => {
		const oldWork = new OldWork();
		oldWork.open();
		expect(oldWork.of(chain({ draining: false }, { draining: false }, { draining: true }).context)).toBe(true);
		expect(oldWork.of(chain({ draining: false }, { draining: false }).context)).toBe(false);
		expect(oldWork.of(context)).toBe(false);
	});

	it("walks no chain while the host has no old work open (no cost outside reloads)", () => {
		const oldWork = new OldWork();
		const calls = chain({ draining: false }, { draining: true });
		expect(oldWork.of(calls.context)).toBe(false);
		expect(calls.steps()).toBe(0);
		oldWork.open();
		expect(oldWork.of(calls.context)).toBe(true);
		expect(calls.steps()).toBe(1);
		oldWork.close();
		expect(oldWork.of(calls.context)).toBe(false);
		expect(calls.steps()).toBe(1);
	});
});

describe("asRemoteOldWork: a call that arrived as old work from another host", () => {
	it("is old work while counted, whatever chain it had", () => {
		const oldWork = new OldWork();
		const marked = asRemoteOldWork(chain({ draining: false }).context);
		expect(oldWork.of(marked)).toBe(false);
		oldWork.open();
		expect(oldWork.of(marked)).toBe(true);
	});

	it("has no attempt of this host in its chain (a reload cycle cannot pass through another host's drain)", () => {
		const local = { draining: true };
		expect([...chainAttempts(asRemoteOldWork(context))]).toEqual([]);
		const above = chain(local).context;
		expect([...chainAttempts(above)]).toEqual([local]);
	});
});

describe("chainAttempts: the attempts a call chain runs on", () => {
	it("collects each attempt once, draining or not", () => {
		const a = { draining: true };
		const b = { draining: false };
		expect([...chainAttempts(chain(a, b, a).context)]).toEqual([a, b]);
		expect([...chainAttempts(context)]).toEqual([]);
	});
});
