import { describe, expect, it } from "vitest";
import { ChordError, PluginError } from "../../../src/next/data/index.ts";
import { errorFromWire, wireError } from "../../../src/next/link/internal.ts";

describe("errors on the wire", () => {
	it("carry a ChordError as its JSON, without stack or cause", () => {
		const error = new ChordError({ code: "invalid", reason: "args", message: "bad" }, { cause: new Error("x") });
		const wire = wireError(error);
		expect(wire).toEqual({ kind: "chord", error: { code: "invalid", reason: "args", message: "bad" } });
		const back = errorFromWire(JSON.parse(JSON.stringify(wire)));
		expect(back).toBeInstanceOf(ChordError);
		expect(back).toMatchObject({ code: "invalid", reason: "args", message: "bad" });
	});

	it("carry a PluginError's code, message and details only; the consumer rethrows a PluginError", () => {
		const error = new PluginError("quota", "too many notes", { limit: 3 });
		const wire = wireError(error);
		expect(wire).toEqual({ kind: "plugin", code: "quota", message: "too many notes", details: { limit: 3 } });
		const back = errorFromWire(wire);
		expect(back).toBeInstanceOf(PluginError);
		expect(back).toMatchObject({ code: "quota", message: "too many notes", details: { limit: 3 } });
		expect(wireError(new PluginError("c", "m"))).toEqual({ kind: "plugin", code: "c", message: "m" });
	});

	it("carry anything else as the plugin code internal with its message", () => {
		expect(wireError(new TypeError("boom"))).toEqual({ kind: "plugin", code: "internal", message: "boom" });
		expect(wireError("plain")).toEqual({ kind: "plugin", code: "internal", message: "plain" });
	});

	it("throw on a malformed ChordError envelope (a protocol error)", () => {
		expect(() => errorFromWire({ kind: "chord", error: { code: "nope", message: "m" } })).toThrow(
			"Invalid ChordError JSON",
		);
	});
});
