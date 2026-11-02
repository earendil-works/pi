import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { int, local, method } from "../../../src/next/contracts/index.ts";
import { loaded } from "../support.ts";

describe("the member check (Q14)", () => {
	it("refuses an inherited property for a member", async () => {
		const Named = local("app.named", { version: 1, params: { id: int() }, members: { toString: method() } });
		const { host } = await loaded((h) => h.serve(Named, () => ({}) as never));
		await expect(host.get(Named, { id: 1 }, context)).rejects.toThrow(
			"app.named(1): toString: a method is a function",
		);
	});

	it("names a derive in errors by its member when exposed, else by its position", async () => {
		const Named = local("app.named", { version: 1, params: { n: int() }, members: { label: int() } });
		const bad = { value: 1 };
		const { host } = await loaded((h) =>
			h.serve(Named, ({ n }, self) => {
				const inner = self.derive(n === 1 ? [] : [bad as never], () => 1);
				return { label: self.derive(n === 1 ? [inner, bad as never] : [inner], () => 2) };
			}),
		);
		await expect(host.get(Named, { n: 1 }, context)).rejects.toThrow(
			"app.named(1): label: source 1 is not a Chord watchable",
		);
		await expect(host.get(Named, { n: 2 }, context)).rejects.toThrow(
			"app.named(2): derive #1: source 0 is not a Chord watchable",
		);
	});
});
