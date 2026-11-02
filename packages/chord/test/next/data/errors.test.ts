import { describe, expect, expectTypeOf, it } from "vitest";
import { ChordError, type ChordErrorReason, isChordError, PluginError } from "../../../src/next/data/index.ts";
import {
	asChordError,
	CHORD_ERROR_REASONS,
	chordErrorFromJson,
	invalid,
	PROTOCOL_VERSION,
} from "../../../src/next/data/internal.ts";

describe("ChordError", () => {
	it("is a tagged union: a wrong pairing is a type error", () => {
		new ChordError({ code: "invalid", reason: "args", message: "m" });
		new ChordError({ code: "unavailable", message: "m" });
		new ChordError({ code: "unavailable", reason: "locked", message: "m" });
		// @ts-expect-error: invalid requires a reason
		new ChordError({ code: "invalid", message: "m" });
		// @ts-expect-error: gone carries no reason
		new ChordError({ code: "gone", reason: "args", message: "m" });
		// @ts-expect-error: part belongs to too_large
		new ChordError({ code: "unavailable", reason: "part", message: "m" });
	});

	it("narrowing on code narrows reason", () => {
		const error = new ChordError({ code: "too_large", reason: "part", message: "m" }) as ChordError;
		if (error.code === "invalid") expectTypeOf(error.reason).toEqualTypeOf<ChordErrorReason<"invalid">>();
		if (error.code === "unavailable")
			expectTypeOf(error.reason).toEqualTypeOf<
				"locked" | "park_timeout" | "busy" | "storage_failed" | "undeclared" | undefined
			>();
		if (error.code === "gone") expectTypeOf(error.reason).toEqualTypeOf<undefined>();
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("ChordError");
	});

	it("round-trips through JSON without stack or cause", () => {
		const details = { path: "/text" };
		const error = new ChordError(
			{ code: "invalid", reason: "args", message: "args/text: bad", details },
			{ cause: new Error("x") },
		);
		const json = JSON.parse(JSON.stringify(error));
		expect(json).toEqual({ code: "invalid", reason: "args", message: "args/text: bad", details });
		const back = chordErrorFromJson(json);
		expect(back).toBeInstanceOf(ChordError);
		expect(back.toJSON()).toEqual(json);
		expect(new ChordError({ code: "gone", message: "m" }).toJSON()).toEqual({ code: "gone", message: "m" });
	});

	it("keeps details by reference", () => {
		const details = { large: [1, 2, 3] };
		expect(chordErrorFromJson({ code: "gone", message: "m", details }).details).toBe(details);
	});

	it.each([
		["not an object", "x", "not an object"],
		["null", null, "not an object"],
		["an array", [], "not an object"],
		["unknown key", { code: "gone", message: "m", stack: "s" }, 'unknown key "stack"'],
		["unknown code", { code: "teapot", message: "m" }, "unknown code"],
		["inherited name as code", { code: "toString", message: "m" }, "unknown code"],
		["code not a string", { code: 1, message: "m" }, "unknown code"],
		["invalid without reason", { code: "invalid", message: "m" }, "reason not allowed for invalid"],
		["reason not allowed", { code: "gone", reason: "args", message: "m" }, "reason not allowed for gone"],
		[
			"reason of another code",
			{ code: "unavailable", reason: "part", message: "m" },
			"reason not allowed for unavailable",
		],
		["message not a string", { code: "gone", message: 1 }, "message is not a string"],
	])("chordErrorFromJson refuses %s", (_case, raw, problem) => {
		expect(() => chordErrorFromJson(raw)).toThrow(`Invalid ChordError JSON: ${problem}`);
	});
});

describe("protocol table", () => {
	it("is pinned together with PROTOCOL_VERSION", () => {
		const pinned = {
			version: 1,
			reasons: {
				invalid: ["args", "params", "member", "host_address", "reentrant", "read_after_bulk", "cycle"],
				contract_mismatch: ["updating"],
				forbidden: ["revoked"],
				gone: [],
				not_ready: [],
				released: ["ended", "closed", "settled", "version", "discarded"],
				too_large: ["part"],
				unavailable: ["locked", "park_timeout", "busy", "storage_failed", "undeclared"],
				aborted: [],
			},
		};
		const changed =
			PROTOCOL_VERSION !== pinned.version || JSON.stringify(CHORD_ERROR_REASONS) !== JSON.stringify(pinned.reasons);
		expect(changed, "the error table changed: bump PROTOCOL_VERSION and update this pin").toBe(false);
	});
});

describe("helpers", () => {
	it("isChordError checks the class and optionally the code", () => {
		const error = invalid("member", "no method");
		expect(isChordError(error)).toBe(true);
		expect(isChordError(error, "invalid")).toBe(true);
		expect(isChordError(error, "gone")).toBe(false);
		expect(isChordError(new Error("x"))).toBe(false);
		expect(isChordError({ code: "invalid", reason: "member", message: "m" })).toBe(false);
	});

	it("invalid builds an invalid error with its reason and details", () => {
		const error = invalid("params", "params/a: missing", { path: "/a" });
		expect(error.toJSON()).toEqual({
			code: "invalid",
			reason: "params",
			message: "params/a: missing",
			details: { path: "/a" },
		});
		expectTypeOf(error.code).toEqualTypeOf<"invalid">();
	});

	it("asChordError keeps a ChordError and wraps anything else as unavailable", () => {
		const chord = invalid("cycle", "c");
		expect(asChordError(chord, "open")).toBe(chord);
		const foreign = new TypeError("boom");
		const wrapped = asChordError(foreign, "open notes");
		expect(wrapped.toJSON()).toEqual({ code: "unavailable", message: "open notes: boom" });
		expect(wrapped.cause).toBe(foreign);
		expect(asChordError("text", "open").message).toBe("open: text");
	});
});

describe("PluginError", () => {
	it("carries a plugin's code, message and JSON details", () => {
		const error = new PluginError("quota", "too many", { limit: 3 });
		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({ name: "PluginError", code: "quota", message: "too many", details: { limit: 3 } });
		expect(new PluginError("c", "m").details).toBeUndefined();
	});
});
