import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { McpClient, StdioTransport } from "../src/index.ts";

const fixture = fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url));

describe("StdioTransport", () => {
	it("connects to a newline-delimited MCP server and captures stderr", async () => {
		const stderr: string[] = [];
		const transport = new StdioTransport({
			command: process.execPath,
			args: [fixture],
			onStderr: (chunk) => stderr.push(chunk),
		});
		const client = new McpClient({ name: "stdio-test", version: "1.0.0" });
		await client.connect(transport);
		expect(await client.listTools()).toEqual([{ name: "echo", inputSchema: { type: "object" } }]);
		expect(await client.callTool("echo", { text: "hello" })).toEqual({
			content: [{ type: "text", text: "hello" }],
		});
		expect(transport.pid).toBeTypeOf("number");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(stderr.join("")).toContain("stdio fixture ready");
		expect(transport.stderr).toContain("stdio fixture ready");
		await client.close();
		expect(client.connectionState).toBe("closed");
	});
});
