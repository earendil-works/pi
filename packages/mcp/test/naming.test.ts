import { describe, expect, it } from "vitest";
import { createMcpToolName, mcpNamespace } from "../src/index.ts";

describe("createMcpToolName", () => {
	it("joins server and tool and replaces characters outside [A-Za-z0-9_]", () => {
		expect(createMcpToolName("docs", "search")).toBe("mcp__docs__search");
		expect(createMcpToolName("my-server", "get.item/v2")).toBe("mcp__my_server__get_item_v2");
	});

	it("shortens names over 64 characters with a hash of server and tool", () => {
		const long = createMcpToolName("server", "x".repeat(100));
		expect(long).toHaveLength(64);
		expect(long).toMatch(/^mcp__server__x+_[0-9a-f]{8}$/);
		// Names that share their first 55 characters still differ.
		expect(createMcpToolName("server", `${"x".repeat(100)}y`)).not.toBe(long);
		// The hash covers the unsanitized names, and is stable.
		expect(createMcpToolName("server", "x".repeat(100))).toBe(long);
		expect(createMcpToolName("ser-ver", "x".repeat(100))).not.toBe(createMcpToolName("ser_ver", "x".repeat(100)));
	});

	it("adds the hash suffix when the sanitized name is taken", () => {
		const taken = createMcpToolName("s", "a_b");
		expect(taken).toBe("mcp__s__a_b");
		const second = createMcpToolName("s", "a-b", (name) => name === taken);
		expect(second).toMatch(/^mcp__s__a_b_[0-9a-f]{8}$/);
		expect(createMcpToolName("s", "a_b", (name) => name === taken)).not.toBe(second);
	});
});

describe("mcpNamespace", () => {
	it("is mcp__<server> with - replaced by _, the prefix of the server's tool names", () => {
		expect(mcpNamespace("docs")).toBe("mcp__docs");
		expect(mcpNamespace("my-server")).toBe("mcp__my_server");
		expect(mcpNamespace("my-server")).toBe(mcpNamespace("my_server"));
		expect(createMcpToolName("my-server", "search").startsWith(`${mcpNamespace("my-server")}__`)).toBe(true);
	});
});
