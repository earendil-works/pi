import { describe, expectTypeOf, it } from "vitest";
import type {
	ChangesAfter,
	CurrentStep,
	Increment,
	OlderVersions,
	StepAt,
} from "../../../src/next/contracts/history.ts";

type Empty = { readonly a: { readonly state: Record<never, never>; readonly methods: Record<never, never> } };
type History = [
	{ version: "9"; variants: Empty; changes: never },
	{ version: "10"; variants: Empty; changes: ["a", "x", "state"] },
	{ version: "11"; variants: Empty; changes: ["a", "m", "args"] },
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
		expectTypeOf<StepAt<History, "10">["changes"]>().toEqualTypeOf<["a", "x", "state"]>();
	});

	it("collects every change after a version", () => {
		expectTypeOf<ChangesAfter<History, "9">>().toEqualTypeOf<["a", "x", "state"] | ["a", "m", "args"]>();
		expectTypeOf<ChangesAfter<History, "10">>().toEqualTypeOf<["a", "m", "args"]>();
		expectTypeOf<ChangesAfter<History, "11">>().toEqualTypeOf<never>();
	});
});
