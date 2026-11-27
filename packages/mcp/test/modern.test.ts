import { describe, expect, it } from "vitest";
import { McpError } from "../src/index.ts";
import {
	isModernProtocolError,
	mutualModernVersion,
	readModernResult,
	readSubscriptionFilter,
	supportedVersions,
	validateDiscoverResult,
	withModernMeta,
} from "../src/protocol/modern.ts";

describe("withModernMeta", () => {
	it("adds the request metadata and keeps other _meta keys", () => {
		expect(
			withModernMeta(
				{ name: "tool", _meta: { progressToken: 3 } },
				{
					protocolVersion: "2026-07-28",
					clientInfo: { name: "client", version: "1.0.0" },
					clientCapabilities: { roots: {} },
					logLevel: "info",
				},
			),
		).toEqual({
			name: "tool",
			_meta: {
				progressToken: 3,
				"io.modelcontextprotocol/protocolVersion": "2026-07-28",
				"io.modelcontextprotocol/clientInfo": { name: "client", version: "1.0.0" },
				"io.modelcontextprotocol/clientCapabilities": { roots: {} },
				"io.modelcontextprotocol/logLevel": "info",
			},
		});
	});
});

describe("readModernResult", () => {
	it("treats results without resultType as complete", () => {
		expect(readModernResult("tools/call", { content: [] })).toEqual({ kind: "complete", result: { content: [] } });
		expect(readModernResult("tools/call", { resultType: "complete", content: [] }).kind).toBe("complete");
	});

	it("reads input requests and request state", () => {
		expect(
			readModernResult("tools/call", {
				resultType: "input_required",
				inputRequests: { roots: { method: "roots/list" } },
				requestState: "opaque",
			}),
		).toEqual({ kind: "input_required", inputRequests: { roots: { method: "roots/list" } }, requestState: "opaque" });
		expect(readModernResult("tools/call", { resultType: "input_required", requestState: "s" })).toEqual({
			kind: "input_required",
			inputRequests: {},
			requestState: "s",
		});
	});

	it("rejects unknown result types and malformed input requests", () => {
		expect(() => readModernResult("tools/call", { resultType: "task" })).toThrow(
			"Unsupported MCP tools/call result type",
		);
		expect(() => readModernResult("tools/call", { resultType: "input_required" })).toThrow("names neither");
		expect(() => readModernResult("tools/call", { resultType: "input_required", inputRequests: { a: {} } })).toThrow(
			"Invalid input requests",
		);
		expect(() => readModernResult("tools/call", { resultType: "input_required", requestState: 1 })).toThrow(
			"Invalid request state",
		);
	});
});

describe("modern errors", () => {
	it("recognizes the codes 2026-07-28 reserves", () => {
		expect(isModernProtocolError(new McpError(-32020, "Header mismatch"))).toBe(true);
		expect(isModernProtocolError(new McpError(-32021, "Missing capability"))).toBe(true);
		const unsupported = new McpError(-32022, "Unsupported protocol version", {
			supported: ["2026-07-28"],
			requested: "1900-01-01",
		});
		expect(isModernProtocolError(unsupported)).toBe(true);
		expect(supportedVersions(unsupported)).toEqual(["2026-07-28"]);
	});

	it("does not mistake legacy errors for modern ones", () => {
		expect(isModernProtocolError(new McpError(-32601, "Method not found"))).toBe(false);
		expect(isModernProtocolError(new McpError(-32000, "Bad Request: Server not initialized"))).toBe(false);
		// -32022 without the version list is not the modern error.
		expect(isModernProtocolError(new McpError(-32022, "Something else"))).toBe(false);
	});

	it("picks the newest version both sides support", () => {
		expect(mutualModernVersion(["2025-11-25", "2026-07-28"])).toBe("2026-07-28");
		expect(mutualModernVersion(["2025-11-25", "2099-01-01"])).toBeUndefined();
	});
});

describe("server/discover", () => {
	it("validates the result and reads the server's name from _meta or the result", () => {
		const discovered = validateDiscoverResult({
			resultType: "complete",
			supportedVersions: ["2026-07-28"],
			capabilities: { tools: {} },
			_meta: { "io.modelcontextprotocol/serverInfo": { name: "server", version: "2.0.0" } },
			ttlMs: 0,
			cacheScope: "public",
		});
		expect(discovered.serverInfo).toEqual({ name: "server", version: "2.0.0" });
		const inline = { supportedVersions: [], capabilities: {}, serverInfo: { name: "inline", version: "1" } };
		expect(validateDiscoverResult(inline).serverInfo).toEqual({ name: "inline", version: "1" });
		expect(validateDiscoverResult({ supportedVersions: [], capabilities: {} }).serverInfo).toBeUndefined();
		expect(() => validateDiscoverResult({ supportedVersions: "2026-07-28", capabilities: {} })).toThrow(
			"Invalid MCP server/discover result",
		);
	});
});

describe("readSubscriptionFilter", () => {
	it("keeps the fields of the right type and drops the rest", () => {
		expect(
			readSubscriptionFilter({
				toolsListChanged: true,
				promptsListChanged: "yes",
				resourceSubscriptions: ["file:///a"],
				unknown: 1,
			}),
		).toEqual({ toolsListChanged: true, resourceSubscriptions: ["file:///a"] });
		expect(readSubscriptionFilter({ resourceSubscriptions: [1] })).toEqual({});
		expect(readSubscriptionFilter(undefined)).toEqual({});
	});
});
