// Tests of the external stores the React bindings read (slice 11 §3), without React: a store's snapshot is the
// watchable's value (`undefined` when it has none, never a throw), and subscribing calls back on every change until
// unsubscribed.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import {
	constant,
	createHost,
	defineFacet,
	hostKind,
	local,
	memoryLinkPair,
	method,
	remote,
	str,
} from "../../../src/index.ts";
import { watchStore } from "../../../src/react/stores.ts";

const Notes = local("test.notes", { version: 1, params: {}, members: { text: str(), write: method(str()) } });

describe("a watch store", () => {
	it("reads the value and calls back on changes until unsubscribed", async () => {
		const host = createHost({ onError: () => {} });
		await host.load(
			[
				{
					name: "@test/notes",
					facet: defineFacet((h) =>
						h.serve(Notes, (_params, self) => {
							const text = self.writable("a");
							return {
								text: self.derive([text], ([value]) => value),
								write: async (next) => {
									text.set(next);
									return null;
								},
							};
						}),
					),
				},
			],
			context,
		);
		const notes = await host.get(Notes, {}, context);
		const store = watchStore(notes.text);
		expect(store.snapshot()).toBe("a");
		let calls = 0;
		const unsubscribe = store.subscribe(() => calls++);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await notes.write("b", context);
		for (let index = 0; index < 100 && store.snapshot() !== "b"; index++) await new Promise((r) => setTimeout(r, 5));
		expect(store.snapshot()).toBe("b");
		const seen = calls;
		expect(seen).toBeGreaterThan(0);
		unsubscribe();
		await notes.write("c", context);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(calls).toBe(seen);
		notes.release();
		await host.close(context);
	});

	it("calls back once a held remote reference binds after the snapshot was read", async () => {
		const Server = hostKind("server");
		const Greeting = remote("test.greeting", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			variants: { main: { state: { text: str() } } },
		});
		const server = createHost({ address: Server(), principal: { kind: "server" }, onError: () => {} });
		await server.load(
			[
				{
					name: "@test/greeting",
					facet: defineFacet((h) =>
						h.serve(Greeting, () => ({ variant: "main", members: { text: constant("hi") } })),
					),
				},
			],
			context,
		);
		const client = createHost({ onError: () => {} });
		await client.load([], context);
		const held = client.hold(Greeting, {}, context);
		const store = watchStore(held.text);
		expect(store.snapshot()).toBeUndefined();
		let calls = 0;
		const unsubscribe = store.subscribe(() => calls++);
		const [mine, theirs] = memoryLinkPair();
		server.accept(theirs, { principal: { kind: "user" } }, context);
		client.connect(mine, { principal: { kind: "server" } }, context);
		for (let index = 0; index < 200 && calls === 0; index++) await new Promise((resolve) => setTimeout(resolve, 5));
		expect(calls).toBeGreaterThan(0);
		expect(store.snapshot()).toBe("hi");
		unsubscribe();
		held.release();
		await client.close(context);
		await server.close(context);
	});

	it("gives undefined for no watchable and for one without a value", () => {
		expect(watchStore(undefined).snapshot()).toBeUndefined();
		expect(watchStore(undefined).subscribe(() => {})).toBeTypeOf("function");
		const failing = {
			get value(): string {
				throw new Error("not ready");
			},
			watch: () => Promise.reject(new Error("x")),
		};
		expect(watchStore(failing).snapshot()).toBeUndefined();
	});
});
