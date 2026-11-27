import { describe, expect, it } from "vitest";
import {
	encodeHeaderValue,
	standardRequestHeaders,
	toolHeaderBindings,
	toolParamHeaders,
} from "../src/protocol/http-headers.ts";

describe("encodeHeaderValue", () => {
	// The examples of the 2026-07-28 Streamable HTTP spec.
	it.each([
		["us-west1", "us-west1"],
		["us west 1", "us west 1"],
		["", ""],
		["Hello, 世界", "=?base64?SGVsbG8sIOS4lueVjA==?="],
		[" padded ", "=?base64?IHBhZGRlZCA=?="],
		["line1\nline2", "=?base64?bGluZTEKbGluZTI=?="],
		["\tindented", "=?base64?CWluZGVudGVk?="],
		["=?base64?literal?=", "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?="],
	])("encodes %j as %j", (value, encoded) => {
		expect(encodeHeaderValue(value)).toBe(encoded);
	});
});

describe("standardRequestHeaders", () => {
	it("names the method, and the tool, prompt, or resource where the method has one", () => {
		expect(standardRequestHeaders("tools/list", {})).toEqual({ "Mcp-Method": "tools/list" });
		expect(standardRequestHeaders("tools/call", { name: "my-tool" })).toEqual({
			"Mcp-Method": "tools/call",
			"Mcp-Name": "my-tool",
		});
		expect(standardRequestHeaders("prompts/get", { name: "greet" })).toEqual({
			"Mcp-Method": "prompts/get",
			"Mcp-Name": "greet",
		});
		expect(standardRequestHeaders("resources/read", { uri: "file:///a%20b.txt" })).toEqual({
			"Mcp-Method": "resources/read",
			"Mcp-Name": "file:///a%20b.txt",
		});
		expect(standardRequestHeaders("tools/call", { name: "café" })["Mcp-Name"]).toBe("=?base64?Y2Fmw6k=?=");
	});
});

describe("toolHeaderBindings", () => {
	it("collects annotations reached through properties, including nested objects", () => {
		expect(
			toolHeaderBindings({
				type: "object",
				properties: {
					region: { type: "string", "x-mcp-header": "Region" },
					options: {
						type: "object",
						properties: { verbose: { type: ["boolean", "null"], "x-mcp-header": "Verbose" } },
					},
					count: { type: "integer", "x-mcp-header": "Count" },
					query: { type: "string" },
				},
			}),
		).toEqual({
			kind: "valid",
			bindings: [
				{ path: ["region"], header: "Region" },
				{ path: ["options", "verbose"], header: "Verbose" },
				{ path: ["count"], header: "Count" },
			],
		});
	});

	it("ignores the key in instance data", () => {
		expect(
			toolHeaderBindings({
				type: "object",
				properties: { config: { type: "object", default: { "x-mcp-header": "nope" } } },
			}),
		).toEqual({ kind: "valid", bindings: [] });
	});

	// The invalid tools of the conformance scenario `http-invalid-tool-headers`.
	it.each([
		["empty", { value: { type: "string", "x-mcp-header": "" } }],
		["object", { data: { type: "object", "x-mcp-header": "Data" } }],
		["array", { items: { type: "array", items: { type: "string" }, "x-mcp-header": "Items" } }],
		["null", { nil: { type: "null", "x-mcp-header": "Nil" } }],
		["number", { ratio: { type: "number", "x-mcp-header": "Ratio" } }],
		["untyped", { value: { "x-mcp-header": "Value" } }],
		[
			"duplicate",
			{ field1: { type: "string", "x-mcp-header": "Region" }, field2: { type: "string", "x-mcp-header": "Region" } },
		],
		[
			"duplicate ignoring case",
			{
				field1: { type: "string", "x-mcp-header": "MyField" },
				field2: { type: "string", "x-mcp-header": "myfield" },
			},
		],
		["space", { value: { type: "string", "x-mcp-header": "My Region" } }],
		["colon", { value: { type: "string", "x-mcp-header": "Region:Primary" } }],
		["non-ASCII", { value: { type: "string", "x-mcp-header": "Région" } }],
		["control character", { value: { type: "string", "x-mcp-header": "Region\t1" } }],
		["array items", { list: { type: "array", items: { type: "string", "x-mcp-header": "Item" } } }],
		["composition", { value: { anyOf: [{ type: "string", "x-mcp-header": "Value" }] } }],
	])("rejects an annotation that is %s", (_case, properties) => {
		expect(toolHeaderBindings({ type: "object", properties }).kind).toBe("invalid");
	});

	it("rejects annotations in definitions and on the root", () => {
		expect(toolHeaderBindings({ type: "object", $defs: { id: { type: "string", "x-mcp-header": "Id" } } }).kind).toBe(
			"invalid",
		);
		expect(toolHeaderBindings({ type: "object", "x-mcp-header": "Root" }).kind).toBe("invalid");
	});
});

describe("toolParamHeaders", () => {
	const bindings = [
		{ path: ["region"], header: "Region" },
		{ path: ["priority"], header: "Priority" },
		{ path: ["verbose"], header: "Verbose" },
		{ path: ["options", "mode"], header: "Mode" },
	];

	it("mirrors strings, integers, and booleans, encoding unsafe strings", () => {
		expect(
			toolParamHeaders(bindings, { region: " us-west1", priority: 42, verbose: false, options: { mode: "fast" } }),
		).toEqual({
			"Mcp-Param-Region": "=?base64?IHVzLXdlc3Qx?=",
			"Mcp-Param-Priority": "42",
			"Mcp-Param-Verbose": "false",
			"Mcp-Param-Mode": "fast",
		});
	});

	it("omits absent, null, and non-primitive values", () => {
		expect(toolParamHeaders(bindings, { region: null, priority: 1.5, options: "flat" })).toEqual({});
		expect(toolParamHeaders(bindings, undefined)).toEqual({});
	});
});
