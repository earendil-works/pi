// Entry 8: what a change costs the provider. The diff is computed once per change; each feed (one per connection and
// member) encodes it with its own stateful encoder and its link serializes it.
import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, it, vi } from "vitest";
import type * as delta from "../src/delta/index.ts";
import { type Ctx, createHost, hostNamed, memoryLinkPair, method, remote } from "../src/index.ts";
import { CountingLink, stateFrames } from "./fixtures/counting.ts";

const counts = vi.hoisted(() => ({ encoders: 0, encodes: 0 }));

vi.mock("../src/delta/index.ts", async (importOriginal) => {
	const original = await importOriginal<typeof delta>();
	return {
		...original,
		encoder: () => {
			counts.encoders++;
			const inner = original.encoder();
			return {
				encode: (ops: Parameters<typeof inner.encode>[0]) => {
					counts.encodes++;
					return inner.encode(ops);
				},
			};
		},
	};
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const List = remote("t.e8-cost", {
	version: 1,
	input: Type.Object({}),
	host: hostNamed("server"),
	variants: { main: { state: { items: Type.Array(Type.String()) }, methods: { add: method(Type.String()) } } },
});

describe("provider cost", () => {
	it("one change to K clients: K encodes (one per feed), one frame per link, the same ops on every link", async () => {
		const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
		server.serve(List, (_input, _principal, self) => {
			const items = self.state("items", Type.Array(Type.String()), []);
			return {
				variant: "main",
				items,
				add: (text: string, ctx: Ctx) => {
					items.change(ctx, (draft) => {
						draft.push(text);
					});
				},
			};
		});
		const K = 4;
		const clients = Array.from({ length: K }, (_, i) => {
			const [down, up] = memoryLinkPair();
			// One principal: every client reaches the same object.
			server.accept(down, { principal: { user: "u" } });
			const link = new CountingLink(up);
			const host = createHost({
				self: { kind: "host" },
				name: `browser${i}`,
				kind: "client",
				upstream: { link, principal: { kind: "server" } },
				onError: () => {},
			});
			return { host, link, ref: host.hold(List, {}) };
		});
		await Promise.all(clients.map((client) => client.ref.ready));
		const encoders = counts.encoders;
		const encodes = counts.encodes;
		const before = clients.map((client) => stateFrames(client.link.received).length);
		await clients[0]!.ref.add("x");
		await sleep(10);
		assert.equal(counts.encodes - encodes, K, "one encode per feed");
		assert.equal(counts.encoders, encoders, "no new streams for a change");
		const frames = clients.map((client, i) => stateFrames(client.link.received).slice(before[i]));
		for (const list of frames) assert.equal(list.length, 1);
		const ops = frames.map((list) => JSON.stringify(list[0]?.ops));
		assert.equal(new Set(ops).size, 1, "every link carries the same ops");
		for (const client of clients) assert.deepEqual(client.ref.items.value, ["x"]);
		await server.close();
	});
});
