// Tests of a reference read in one variant (decision "C15 stands; the UI bindings follow the variant"): narrowed while
// live in that variant, nothing before it binds, in another variant, while it loads between two, denied or released.

import { describe, expect, expectTypeOf, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import type { Held, Reference, RefIn } from "../../src/host/index.ts";
import { type InVariant, liveIn } from "../../src/surfaces/variant.ts";
import { Desk, desk } from "../support.ts";

describe("liveIn", () => {
	it("is the reference while it is live in the variant, nothing before it binds or for no reference", async () => {
		const { client } = await desk();
		const held = client.hold(Desk, {}, context);
		expect(liveIn(held, "reader")).toBeUndefined();
		expect(liveIn(undefined as typeof held | undefined, "reader")).toBeUndefined();
		await expect.poll(() => held.state.value.kind).toBe("live");
		expect(liveIn(held, "reader")).toBe(held);
		expect(liveIn(held, "editor")).toBeUndefined();
		held.release();
	});

	it("follows the variant an admission rebinds: nothing while it loads between two, denied or released", async () => {
		const { client, admit } = await desk();
		const held = client.hold(Desk, {}, context);
		await expect.poll(() => liveIn(held, "reader")).toBe(held);
		// Each state as its watch gets it, with what the reference is read as then.
		const seen: string[] = [];
		const watch = await held.state.watch(context);
		watch.start(async (call) => {
			if (call.kind !== "value") return;
			const read = liveIn(held, "reader") ?? liveIn(held, "editor");
			seen.push(`${call.value.kind} ${held.variant}: read as ${read?.variant}`);
		});
		await admit("editor");
		await expect.poll(() => liveIn(held, "editor")).toBe(held);
		expect(liveIn(held, "reader")).toBeUndefined();
		await liveIn(held, "editor")!.write("edited", context);
		await admit("none");
		await expect.poll(() => held.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } });
		expect(liveIn(held, "editor")).toBeUndefined();
		await admit("reader");
		await expect.poll(() => liveIn(held, "reader")).toBe(held);
		// While it loads between two variants it still says the last one: the comparison alone would keep an editor's
		// controls up.
		expect(seen).toEqual([
			"loading reader: read as undefined",
			"live editor: read as editor",
			"failed undefined: read as undefined",
			"loading undefined: read as undefined",
			"live reader: read as reader",
		]);
		held.release();
		expect(liveIn(held, "reader")).toBeUndefined();
	});

	it("narrows a held and a got reference to the variant's members", () => {
		type Editor = InVariant<Held<typeof Desk>, "editor">;
		expectTypeOf<Editor["variant"]>().toEqualTypeOf<"editor">();
		expectTypeOf<Editor>().toHaveProperty("write");
		expectTypeOf<InVariant<Held<typeof Desk>, "reader">>().not.toHaveProperty("write");
		expectTypeOf<InVariant<Reference<typeof Desk>, "editor">>().toMatchTypeOf<RefIn<typeof Desk, "editor">>();
		// @ts-expect-error: no such variant
		liveIn(undefined as Held<typeof Desk> | undefined, "owner");
	});
});
