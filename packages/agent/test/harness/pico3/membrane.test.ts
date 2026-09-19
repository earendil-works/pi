import assert from "node:assert/strict";
import { onTestFinished, test } from "vitest";
import { Membrane } from "../../../src/harness/pico3/membrane.ts";
import { defineTask, type JsonValue, type Namespace } from "../../../src/harness/pico3/types.ts";
import { ctx, open } from "./helpers.ts";

test("membrane unit: root and nested wrappers share one liveness flag; identity preserved; wrappers cannot be assigned into the doc", () => {
	const target = { a: { b: [1, 2] } };
	const m = new Membrane("t");
	const root = m.wrap(target);
	const nested = root.a;
	const arr = root.a.b;
	assert.equal(root.a, nested); // WeakMap identity
	assert.notEqual(nested, target.a); // never the raw object
	arr.push(3);
	assert.deepEqual(target.a.b, [1, 2, 3]); // forwarded
	assert.throws(() => {
		(root as { c?: unknown }).c = nested;
	}, /assigning a document proxy/);
	assert.deepEqual(Object.keys(root), ["a"]);
	assert.notEqual(Object.getOwnPropertyDescriptor(root, "a")!.value, target.a); // descriptors do not leak raw
	const assigned = { value: 1 };
	Object.defineProperty(root, "defined", { value: assigned, enumerable: true, writable: true, configurable: true });
	assigned.value = 2;
	assert.deepEqual((target as { defined?: { value: number } }).defined, { value: 1 });
	assert.throws(() => Object.defineProperty(root, "accessor", { get: () => 1 }), /cannot define accessors/);
	assert.throws(() => Object.setPrototypeOf(root, null), /cannot change prototypes/);
	assert.throws(() => Object.preventExtensions(root), /cannot change extensibility/);
	m.revoke();
	assert.throws(() => root.a, TypeError);
	assert.throws(() => nested.b, TypeError);
	assert.throws(() => arr.length, TypeError);
	assert.throws(() => arr.push(4), TypeError);
	assert.throws(() => {
		nested.b = [];
	}, TypeError);
	assert.throws(() => Object.keys(nested), TypeError);
	assert.throws(() => "b" in nested, TypeError);
	assert.throws(() => Object.isExtensible(nested), TypeError);
	assert.deepEqual(target.a.b, [1, 2, 3]); // nothing changed after revoke
});

test("escaped root and nested handles throw after a successful commit, and their attempted mutations are not persisted by a later commit", async () => {
	const env = await open({});
	onTestFinished(() => env.close());
	const state = env.h.namespace<{ list: JsonValue[]; unrelated: boolean }>("test.membrane-success", {
		rewindable: { list: [] },
		sticky: { unrelated: false },
	});
	let root!: { [k: string]: JsonValue | undefined };
	let nested!: JsonValue[];
	await env.root.commit((tx) => {
		root = tx.plugins(state);
		root.list = [1];
		nested = root.list as JsonValue[];
	}, ctx);
	assert.throws(() => {
		root.x = 1;
	}, /outside its transaction/);
	assert.throws(() => nested.push(2), /outside its transaction/);
	assert.throws(() => root.list, /outside its transaction/);
	await env.root.commit((tx) => {
		tx.plugins(state).unrelated = true;
	}, ctx); // a later unrelated commit
	const r = await env.root.rewindable(ctx);
	assert.deepEqual(r.plugins["test.membrane-success"], { list: [1] });
});

test("array callbacks receive membrane wrappers rather than raw tracked children", async () => {
	const env = await open({});
	onTestFinished(() => env.close());
	const state = env.h.namespace<{ list: { mode: string }[]; unrelated: boolean }>("test.membrane-callback", {
		rewindable: { list: [] },
		sticky: { unrelated: false },
	});
	const escaped: { mode: string }[] = [];
	await env.root.commit((tx) => {
		const list = tx.plugins(state).list;
		list.push({ mode: "safe" });
		list.forEach((item) => {
			escaped.push(item);
		});
		list.map((item) => escaped.push(item));
		list.find((item) => {
			escaped.push(item);
			return true;
		});
		list.sort((a, b) => {
			escaped.push(a, b);
			return 0;
		});
	}, ctx);
	for (const item of escaped)
		assert.throws(() => {
			item.mode = "escaped";
		}, /outside its transaction/);
	await env.root.commit((tx) => {
		tx.plugins(state).unrelated = true;
	}, ctx);
	assert.deepEqual((await env.root.rewindable(ctx)).plugins["test.membrane-callback"], {
		list: [{ mode: "safe" }],
	});
});

test("escaped handles throw after a failed callback too, and the failed transaction's writes are gone", async () => {
	const env = await open({});
	onTestFinished(() => env.close());
	const state = env.h.namespace<{ obj: { [key: string]: JsonValue }; unrelated: boolean }>("test.membrane-failure", {
		rewindable: { obj: {} },
		sticky: { unrelated: false },
	});
	let root!: { [k: string]: JsonValue | undefined };
	let nested!: { [k: string]: JsonValue | undefined };
	await assert.rejects(
		env.root.commit((tx) => {
			root = tx.plugins(state);
			root.obj = { k: 1 };
			nested = root.obj as { [k: string]: JsonValue | undefined };
			throw new Error("boom");
		}, ctx),
		/boom/,
	);
	assert.throws(() => {
		nested.k = 2;
	}, /outside its transaction/);
	assert.throws(() => {
		root.obj = null;
	}, /outside its transaction/);
	await env.root.commit((tx) => {
		tx.plugins(state).unrelated = true;
	}, ctx);
	assert.deepEqual((await env.root.rewindable(ctx)).plugins["test.membrane-failure"], { obj: {} });
});

test("a task runtime's document handle is revoked when its commit ends", async () => {
	let escaped: { [k: string]: JsonValue | undefined } | undefined;
	let state!: Namespace<{ v: number }>;
	let threw: unknown;
	const k = defineTask<null, { phase: "x" }, null, null, null>({
		name: "esc",
		async initial(_t, rt, c) {
			await rt.commit((tx) => {
				escaped = tx.plugins(state);
				escaped.v = 1;
			}, c);
			try {
				escaped!.v = 2;
			} catch (e) {
				threw = e;
			}
			return { done: () => ({ status: "completed", result: null }) };
		},
		phases: {
			async x() {
				return { done: () => ({ status: "completed", result: null }) };
			},
		},
		async abort() {
			return () => null;
		},
	});
	const env = await open({ taskKinds: [k] });
	onTestFinished(() => env.close());
	state = env.h.namespace("test.membrane-runtime", { sticky: { v: 0 } });
	const ref = await env.root.commit((tx) => tx.createTask(k, null, { conversationId: 1, background: true }), ctx);
	await env.h.waitForTask(ref.id, ctx);
	assert.ok(threw instanceof TypeError);
	assert.equal((await env.root.sticky(ctx)).plugins["test.membrane-runtime"]?.v, 1);
});
