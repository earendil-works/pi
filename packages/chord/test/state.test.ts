import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, it } from "vitest";
import { applyImmutable } from "../src/delta/index.ts";
import { type Ctx, createHost, isChordError, local, method, type StateEvent } from "../src/index.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function emitter<E>() {
	const listeners = new Set<(event: E) => void>();
	return {
		emit: (event: E) => {
			for (const fn of listeners) fn(event);
		},
		subscribe: (fn: (event: E) => void) => {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		get size() {
			return listeners.size;
		},
	};
}

const Item = Type.Object({ id: Type.Number(), label: Type.String() });
const Items = Type.Object({ items: Type.Array(Item), count: Type.Number() });

const List = local("t.list", {
	version: 1,
	input: Type.Object({}),
	members: {
		list: Items,
		labels: Type.Array(Type.String()),
		push: method(Item),
		set: method(Items),
	},
});

function serveList(host: ReturnType<typeof createHost>) {
	host.serve(List, (_input, _principal, self) => {
		const listState = self.state("list", Items, { items: [], count: 0 });
		const labels = self.derive([listState], (list) => list.items.map((item) => item.label));
		return {
			list: listState,
			labels,
			push: (item: { id: number; label: string }, ctx: Ctx) => {
				listState.change(ctx, (draft) => {
					draft.items.push(item);
					draft.count += 1;
				});
			},
			set: (value: { items: { id: number; label: string }[]; count: number }, ctx: Ctx) => {
				listState.replace(ctx, value);
			},
		};
	});
}

describe("state cells", () => {
	it("publishes snapshots then exact ops; derivations follow", async () => {
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		serveList(host);
		const ref = host.hold(List, {});
		const events: StateEvent<unknown>[] = [];
		const labels: StateEvent<unknown>[] = [];
		ref.list.events((event) => events.push(event));
		ref.labels.events((event) => labels.push(event));
		await ref.push({ id: 1, label: "a" });
		// Subscribed while loading: the snapshot once live, then exact ops.
		assert.deepEqual(events[0], { type: "snap", value: { items: [], count: 0 } });
		const ops = events[1]?.type === "ops" ? events[1].ops.map((op) => JSON.stringify(op)).sort() : [];
		assert.deepEqual(ops, ['["p",["items"],0,0,[{"id":1,"label":"a"}]]', '["s",["count"],1]']);
		assert.deepEqual(events[1]?.value, { items: [{ id: 1, label: "a" }], count: 1 });
		assert.deepEqual(ref.labels.value, ["a"]);
		assert.deepEqual(
			labels.map((event) => event.type),
			["snap", "ops"],
		);
		await ref.set({ items: [], count: 0 });
		assert.deepEqual(ref.labels.value, []);
	});

	it("supports primitive cells and value-returning changes", async () => {
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		const Counter = local("t.prim", {
			version: 1,
			input: Type.Object({}),
			members: { n: Type.Number(), inc: method(undefined, Type.Number()) },
		});
		host.serve(Counter, (_input, _principal, self) => {
			const nState = self.state("n", Type.Number(), 0);
			return {
				n: nState,
				inc: (ctx: Ctx) => {
					nState.change(ctx, (n) => n + 1);
					return nState.value;
				},
			};
		});
		const ref = host.hold(Counter, {});
		const values: unknown[] = [];
		await ref.ready;
		const events: StateEvent<unknown>[] = [];
		ref.n.events((event) => events.push(event));
		ref.n.subscribe((value) => values.push(value));
		assert.equal(await ref.inc(), 1);
		assert.equal(await ref.inc(), 2);
		assert.deepEqual(values, [0, 1, 2]);
		assert.deepEqual(events, [
			{ type: "snap", value: 0 },
			{ type: "ops", ops: [["r", 1]], value: 1 },
			{ type: "ops", ops: [["r", 2]], value: 2 },
		]);
	});

	it("rejects a returned value that does not fit the schema, even outside dev mode", async () => {
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		const Box = local("t.box", {
			version: 1,
			input: Type.Object({}),
			members: { put: method() },
		});
		host.serve(Box, (_input, _principal, self) => {
			const list = self.state("list", Type.Array(Type.Number()), []);
			return {
				put: (ctx: Ctx) => {
					// The classic slip: an expression-bodied arrow returns push()'s length.
					list.change(ctx, (draft) => draft.push(1) as never);
				},
			};
		});
		await assert.rejects(host.hold(Box, {}).put(), (error) => isChordError(error, "invalid"));
	});

	it("validates initial values always and writes only in dev mode", async () => {
		const Bad = local("t.bad-initial", { version: 1, input: Type.Object({}) });
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		host.serve(Bad, (_input, _principal, self) => {
			self.state("x", Type.Object({ n: Type.Number() }), { n: "no" } as never);
			return {};
		});
		await assert.rejects(host.hold(Bad, {}).ready, /initial value of state x/);

		const lax = createHost({ self: { kind: "host" }, onError: () => {} });
		serveList(lax);
		await lax.hold(List, {}).set({ items: [], count: "x" } as never);

		const dev = createHost({ self: { kind: "host" }, dev: true, onError: () => {} });
		serveList(dev);
		const ref = dev.hold(List, {});
		await assert.rejects(
			ref.set({ items: [], count: "x" } as never),
			(error) => isChordError(error, "invalid") && error.reason === "state",
		);
		assert.deepEqual(ref.list.value, { items: [], count: 0 });
	});

	it("rejects writes from inside a factory and placeholder use before activation", async () => {
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		const Writer = local("t.writer", { version: 1, input: Type.Object({}) });
		let captured: Ctx | undefined;
		await host.root((ctx) => {
			captured = ctx;
		});
		host.serve(Writer, (_input, _principal, self) => {
			const x = self.state("x", Type.Object({}), {});
			const r = self.resource("r", { version: 1, open: () => 1 });
			assert.throws(
				() => r.value,
				(error) => isChordError(error, "not_ready"),
			);
			x.replace(captured!, {});
			return {};
		});
		await assert.rejects(host.hold(Writer, {}).ready, /read_only/);
	});

	it("listeners run each event in a fresh root; tasks get an abortable ctx", async () => {
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		const events = emitter<number>();
		const Watcher = local("t.watcher", {
			version: 1,
			input: Type.Object({}),
			members: { seen: Type.Object({ sum: Type.Number() }) },
		});
		const roots = new Set<string>();
		let taskAborted = false;
		host.serve(Watcher, (_input, _principal, self) => {
			const seen = self.state("seen", Type.Object({ sum: Type.Number() }), { sum: 0 });
			const sourceResource = self.resource("source", { version: 1, open: () => events });
			self.on(
				"onEvent",
				sourceResource,
				(source) => source,
				(value, ctx) => {
					roots.add(ctx.rootId);
					seen.change(ctx, (draft) => {
						draft.sum += value;
					});
				},
			);
			self.task(async (ctx) => {
				await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
				taskAborted = true;
			});
			return { seen };
		});
		const ref = host.hold(Watcher, {});
		await ref.ready;
		events.emit(2);
		events.emit(3);
		await tick();
		assert.deepEqual(ref.seen.value, { sum: 5 });
		assert.equal(roots.size, 2);
		ref.release();
		await tick();
		await tick();
		assert.equal(events.size, 0);
		assert.ok(taskAborted);
	});

	it("re-entrant writes publish in adoption order; derivations never go stale (Sol #3)", async () => {
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		const Echo = local("t.reentrant", {
			version: 1,
			input: Type.Object({}),
			members: { n: Type.Number(), d: Type.Number(), set: method(Type.Number()) },
		});
		host.serve(Echo, (_input, _principal, self) => {
			const nState = self.state("n", Type.Number(), 0);
			const d = self.derive([nState], (n) => n * 2);
			// Subscribed first: re-enters the write while revision 1 is being published.
			self.on("bump", nState, (n, ctx) => {
				if (n === 1) nState.replace(ctx, 2);
			});
			return {
				n: nState,
				d,
				set: (value: number, ctx: Ctx) => {
					nState.replace(ctx, value);
				},
			};
		});
		const ref = host.hold(Echo, {});
		await ref.ready;
		const values: unknown[] = [];
		let replica: unknown;
		ref.n.events((event) => {
			replica = event.type === "ops" ? applyImmutable(replica, event.ops) : event.value;
			values.push(replica);
		});
		const doubled: unknown[] = [];
		ref.d.subscribe((value) => doubled.push(value));
		await ref.set(1);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(values, [0, 1, 2]);
		assert.equal(ref.d.value, 4);
		assert.deepEqual(doubled, [0, 2, 4]);
	});
});
