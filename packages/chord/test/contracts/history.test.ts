import { describe, expectTypeOf, it } from "vitest";
import type { ChangesAfter, CurrentStep, Increment, OlderVersions, StepAt } from "../../src/contracts/history.ts";

type Empty = { readonly state: Record<never, never>; readonly methods: Record<never, never> };
type History = [
	{ version: "9"; members: Empty; changes: never },
	{ version: "10"; members: Empty; changes: ["x", "state"] },
	{ version: "11"; members: Empty; changes: ["m", "args"] },
];

describe("type-level history", () => {
	it("increments decimal versions", () => {
		expectTypeOf<Increment<"1">>().toEqualTypeOf<"2">();
		expectTypeOf<Increment<"9">>().toEqualTypeOf<"10">();
		expectTypeOf<Increment<"19">>().toEqualTypeOf<"20">();
		expectTypeOf<Increment<"99">>().toEqualTypeOf<"100">();
		expectTypeOf<Increment<"1099">>().toEqualTypeOf<"1100">();
	});

	it("finds the current step, older versions and steps by version", () => {
		expectTypeOf<CurrentStep<History>["version"]>().toEqualTypeOf<"11">();
		expectTypeOf<OlderVersions<History>>().toEqualTypeOf<"9" | "10">();
		expectTypeOf<StepAt<History, "10">["changes"]>().toEqualTypeOf<["x", "state"]>();
	});

	it("collects every change after a version", () => {
		expectTypeOf<ChangesAfter<History, "9">>().toEqualTypeOf<["x", "state"] | ["m", "args"]>();
		expectTypeOf<ChangesAfter<History, "10">>().toEqualTypeOf<["m", "args"]>();
		expectTypeOf<ChangesAfter<History, "11">>().toEqualTypeOf<never>();
	});
});
