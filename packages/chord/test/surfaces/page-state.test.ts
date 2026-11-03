// Tests of page state (decision "Tutorial gaps" (1)): a client host's values by key, kept for the host's life, whatever
// asks for them (a remounted component, a new scope); a new key starts at its initial value; sets call the subscribers;
// the store goes with its host.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { createHost } from "../../src/index.ts";
import { pageState } from "../../src/surfaces/page-state.ts";
import { expectCollected } from "../support.ts";

/** A client host with nothing to load. */
async function client() {
	const host = createHost({ onError: () => {} });
	await host.load([], context);
	return host;
}

describe("a host's page state by key", () => {
	it("keeps a key's value for whoever asks next, its own initial value ignored", async () => {
		const host = await client();
		pageState(host, "draft", "").set("oat mi");
		expect(pageState(host, "draft", "").read()).toBe("oat mi");
		await host.close(context);
	});

	it("starts a new key, or the same key on another host, at its initial value", async () => {
		const host = await client();
		const other = await client();
		pageState(host, "draft", "").set("oat mi");
		expect(pageState(host, "scroll", 0).read()).toBe(0);
		expect(pageState(other, "draft", "").read()).toBe("");
		await host.close(context);
		await other.close(context);
	});

	it("holds any value as it was set, never copied", async () => {
		const host = await client();
		const selection = { start: 2, end: 4, element: () => null };
		pageState<typeof selection | undefined>(host, "selection", undefined).set(selection);
		expect(pageState(host, "selection", undefined).read()).toBe(selection);
		await host.close(context);
	});
});

describe("following a key", () => {
	it("calls every subscriber after a set that changed the value, until it unsubscribes", async () => {
		const host = await client();
		const state = pageState(host, "draft", "");
		const calls: string[] = [];
		const first = state.subscribe(() => calls.push(`first ${state.read()}`));
		state.subscribe(() => calls.push(`second ${state.read()}`));
		state.set("a");
		state.set("a");
		first();
		state.set("b");
		expect(calls).toEqual(["first a", "second a", "second b"]);
		await host.close(context);
	});
});

describe("the store's memory", () => {
	it("is collected with its host", async () => {
		const [host, value] = await (async () => {
			const created = await client();
			const kept = { text: "oat mi" };
			pageState(created, "draft", kept);
			await created.close(context);
			return [new WeakRef(created), new WeakRef(kept)];
		})();
		await expectCollected(host, value);
	});
});
