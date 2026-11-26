// The lifecycle's and the removal's waits for the store to serve end with their caller's context (ERNDL-1187): when
// the store's `onLive` fails before it serves (a close or a reload during its first commit), the hooks routine's
// `resume`, and a create's `undo`, return once their context aborts, so a close never drains for its 30 s timeout.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Ctx, BACKGROUND_CONTEXT as context, type P3Principal, withCancel } from "@earendil-works/p3/v1";
import { Lifecycle } from "../lifecycle.ts";
import { Removal } from "../removal.ts";

/**
 * A routine's context that `cancel` aborts. Before the store serves, the lifecycle and the removal read only its abort
 * signal, so a plain context stands in for a routine's `Ctx` here.
 */
function routine(): { ctx: Ctx<P3Principal>; cancel: () => void } {
	const cancelled = withCancel(context);
	return { ctx: cancelled.context as Ctx<P3Principal>, cancel: () => cancelled.cancel("closed") };
}

/** Rejects when `promise` takes longer than `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms);
	});
	try {
		return await Promise.race([promise, late]);
	} finally {
		clearTimeout(timer);
	}
}

/** Stores that fail every call: before the store serves none may be reached. */
const unreachable = () => {
	throw new Error("the store was reached before it served");
};

describe("waiting for the store to serve", () => {
	it("a never-served lifecycle's resume and undo end with their context", async () => {
		const lifecycle = new Lifecycle({
			table: undefined as never,
			write: unreachable,
			pending: unreachable,
			hooks: () => new Map(),
		});
		const { ctx, cancel } = routine();
		const resuming = lifecycle.resume(ctx);
		const undoing = lifecycle.undo("t", "k", ctx);
		cancel();
		await within(Promise.all([resuming, undoing]), 1000);
	});

	it("a never-served removal's resume ends with its context", async () => {
		const removal = new Removal({
			removing: undefined as never,
			gone: undefined as never,
			read: unreachable,
			under: unreachable,
			clear: unreachable,
			hooks: () => new Map(),
		});
		const { ctx, cancel } = routine();
		const resuming = removal.resume(ctx);
		cancel();
		await within(resuming, 1000);
	});

	it("once served, resume reads what is due under the store's own context", async () => {
		const seen: unknown[] = [];
		const lifecycle = new Lifecycle({
			table: undefined as never,
			write: unreachable,
			pending: async (ctx) => {
				seen.push(ctx);
				return [];
			},
			hooks: () => new Map(),
		});
		const store = routine();
		const serving = lifecycle.serve(store.ctx);
		await within(lifecycle.resume(routine().ctx), 1000);
		assert.ok(seen.length >= 1 && seen.every((ctx) => ctx === store.ctx));
		store.cancel();
		await within(serving, 1000);
	});
});
