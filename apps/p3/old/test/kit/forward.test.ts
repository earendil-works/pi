// Tests of `forward`: a view's members taken from a store's reference, on one host, and what its types refuse (checked
// by `npm run check`: an unused `@ts-expect-error` fails it).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHost } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	constant,
	defineFacet,
	defineState,
	forward,
	int,
	local,
	method,
	obj,
	type P3Principal,
	type Reference,
	remote,
	Server,
	str,
} from "@earendil-works/p3/v1";

/** A store with more members than its view shows. */
const Store = local("test.store", {
	version: 1,
	params: {},
	members: { count: int(), secret: str(), add: method(int(), int()), reset: method() },
});

const Count = defineState("test.count", { schema: obj({ count: int() }), version: 1, initial: () => ({ count: 0 }) });

/** The view: the store's `count`, `add` and `reset`, and `who`, which needs its caller. */
const View = remote("test.view", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		user: {
			state: { count: int() },
			methods: { add: method(int(), int()), reset: method(), who: method(undefined, str()) },
		},
	},
});

const facet = defineFacet((host) => {
	host.serve(Store, (_params, self) => {
		const state = self.state(Count);
		const add = async (by: number, ctx: Parameters<typeof state.change>[1]) => {
			await state.change((draft) => {
				draft.count += by;
			}, ctx);
			return state.value.count;
		};
		return {
			count: self.derive([state], ([value]) => value.count),
			secret: self.derive([state], () => "hidden"),
			add,
			reset: async (ctx) => {
				await add(-state.value.count, ctx);
				return null;
			},
		};
	});
	host.serve(View, (_params, principal, self) =>
		forward(self.get(Store, {}), View, "user", { who: async () => principal.kind }),
	);
});

/** A worker's own contract on the server, and the view of it on the worker: the shape of `plugins/sessions/worker.ts`. */
const Facts = remote("test.facts", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { worker: { state: { text: str() } } },
});
const Mirror = remote("test.mirror", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { owner: { state: { text: str() } } },
});

/** Never called: what the types of `forward` accept and refuse. */
function typed(store: Reference<typeof Store>, facts: Reference<typeof Facts>): void {
	const who = async () => "someone";
	forward(store, View, "user", { who });
	// @ts-expect-error `who` is neither the store's nor the view's own
	forward(store, View, "user");
	// @ts-expect-error the store lacks `count`, `add` and `reset`
	forward({}, View, "user", { who });
	// @ts-expect-error the store's `count` has another type
	forward({ ...store, count: constant("text") }, View, "user", { who });
	// @ts-expect-error the view's own `who` has another type
	forward(store, View, "user", { who: async () => 1 });
	// Without `own`, a remote reference forwarded whole.
	forward(facts, Mirror, "owner");
	// @ts-expect-error without `own`, a missing member
	forward({}, Mirror, "owner");
	// @ts-expect-error without `own`, a member of another type
	forward({ text: constant(1) }, Mirror, "owner");
}

describe("forward", () => {
	it("gives a view the store's state and methods, and its own members", async () => {
		const host = createHost<P3Principal>({ address: Server(), principal: { kind: "server" }, onError: () => {} });
		await host.load([{ name: "@test/forward", facet }], context);
		const view = await host.get(View, {}, context);
		// Only the view's members: the store's `secret` is not one.
		assert.equal("secret" in view, false);
		assert.equal(await view.add(2, context), 2);
		assert.equal(await view.add(3, context), 5);
		// The store's state, live.
		assert.equal(view.count.value, 5);
		// A method without arguments, and the view's own member.
		await view.reset(context);
		assert.deepEqual([view.count.value, await view.who(context)], [0, "server"]);
		await host.close(context);
	});
});

void typed;
