// Values shared across compiled schemas hold nothing alive: a cached pattern goes once its schemas are collected.

import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { sharedRegexCount } from "../src/shared.ts";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

async function collectGarbage(): Promise<void> {
	for (let round = 0; round < 6; round++) {
		await new Promise((resolve) => setImmediate(resolve));
		gc();
	}
}

describe("shared checks", () => {
	it("share the module-level check of a bare type", () => {
		const a = compile({ type: "string", description: "a" });
		const b = compile({ type: "string", title: "b" });
		expect(a.check).toBe(b.check);
	});

	it("share a pattern's regular expression and drop it with the last schema that uses it", async () => {
		await collectGarbage();
		const before = sharedRegexCount();
		let validators: { check: object }[] | undefined = Array.from({ length: 50 }, (_, i) =>
			compile({ type: "string", pattern: `^unique-${i}$` }),
		);
		const again = compile({ type: "string", pattern: "^unique-0$" });
		expect(sharedRegexCount()).toBe(before + 50);
		expect(again.check("unique-0")).toBe(true);
		const check = new WeakRef(validators[0].check);
		validators = undefined;
		await collectGarbage();
		// `again` still uses ^unique-0$; the other 49 patterns are gone.
		expect(check.deref()).toBeUndefined();
		expect(sharedRegexCount()).toBe(before + 1);
	});
});
