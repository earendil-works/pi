// Tests of a reference as a UI reads it (slice 15 §1.5): the reference while live and while it loads again after it
// was live, nothing before its first binding, denied or released; its `granted` changes with an admission's rebind.

import { describe, expect, expectTypeOf, it } from "vitest";
import { type Context, BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import type { Reference } from "../../src/host/index.ts";
import { liveGrant } from "../../src/surfaces/live.ts";
import { Desk, desk } from "../support.ts";

describe("liveGrant", () => {
	it("is the reference's grant while it is live, nothing before it binds or for no reference", async () => {
		const { client } = await desk();
		const held = client.hold(Desk, {}, context);
		expect(liveGrant(held)).toBeUndefined();
		expect(liveGrant(undefined)).toBeUndefined();
		await expect.poll(() => held.state.value.kind).toBe("live");
		expect(liveGrant(held)).toBe(held.granted);
		expect([...held.granted]).toEqual([]);
		held.release();
	});

	it("follows the grant an admission rebinds: kept while it loads after live, nothing denied or released", async () => {
		const { client, admit } = await desk();
		const held = client.hold(Desk, {}, context);
		await expect.poll(() => liveGrant(held)).toBeDefined();
		// Each state as its watch gets it, with what the reference is read as then.
		const seen: string[] = [];
		const watch = await held.state.watch(context);
		watch.start(async (call) => {
			if (call.kind !== "value") return;
			const read = liveGrant(held);
			seen.push(`${call.value.kind}: ${read === undefined ? "none" : [...read].join(",") || "plain"}`);
		});
		await admit("editor");
		await expect.poll(() => held.write).toBeDefined();
		const editing = liveGrant(held);
		await held.write!("edited", context);
		await admit("none");
		await expect.poll(() => held.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } });
		expect([liveGrant(held), held.write]).toEqual([undefined, undefined]);
		await admit("reader");
		await expect.poll(() => liveGrant(held)).toBeDefined();
		// A rebind is a new grant: what a UI compares to redraw.
		expect(liveGrant(held)).not.toBe(editing);
		await expect.poll(() => seen.length).toBe(5);
		// After the denial it settled failed: loading again, it is nothing until it is live.
		expect(seen).toEqual(["loading: plain", "live: write", "failed: none", "loading: none", "live: plain"]);
		held.release();
		expect(liveGrant(held)).toBeUndefined();
	});

	it("types a reference's grantable members as optional and its grant as the contract's names", () => {
		type Ref = Reference<typeof Desk>;
		expectTypeOf<Ref["granted"]>().toEqualTypeOf<ReadonlySet<"write">>();
		expectTypeOf<Ref["write"]>().toEqualTypeOf<((args: string, context: Context) => Promise<null>) | undefined>();
		expectTypeOf<Ref["text"]["value"]>().toEqualTypeOf<string>();
	});
});
