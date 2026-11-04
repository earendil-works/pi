import { describe, expect, it } from "vitest";
import { normalizeMcpInputSchema } from "../src/index.ts";

describe("normalizeMcpInputSchema", () => {
	it("adds type object and empty properties when missing", () => {
		expect(normalizeMcpInputSchema({})).toEqual({ type: "object", properties: {} });
		expect(normalizeMcpInputSchema({ type: "object" })).toEqual({ type: "object", properties: {} });
	});

	it("keeps the schema's own keywords", () => {
		const schema = {
			type: "object",
			properties: { query: { type: "string" } },
			required: ["query"],
			additionalProperties: false,
		};
		expect(normalizeMcpInputSchema(schema)).toEqual(schema);
		expect(normalizeMcpInputSchema({ properties: { a: {} }, $defs: { x: {} } })).toEqual({
			type: "object",
			properties: { a: {} },
			$defs: { x: {} },
		});
	});
});
