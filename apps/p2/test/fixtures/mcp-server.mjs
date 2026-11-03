// A stdio MCP server for p2's MCP tests, in the style of pi-mcp's test/fixtures/stdio-server.mjs. Tools: `echo`
// ({ text }), `whoami` (its pid, its parent's, cwd, the client's roots and its `MCP_FIXTURE_*` variables), `crash`
// (answers, then exits), `grow` (adds the tool `extra` and announces the change). `MCP_FIXTURE_LOG`: a file every start
// appends its pid to; `MCP_FIXTURE_HANG`: never answers `initialize`.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.env.MCP_FIXTURE_LOG) appendFileSync(process.env.MCP_FIXTURE_LOG, `${process.pid}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const tools = [
	{
		name: "echo",
		description: "Echoes the text back",
		inputSchema: { type: "object", properties: { text: { type: "string" } } },
	},
	{ name: "whoami", description: "Reports the server process", inputSchema: { type: "object" } },
	{ name: "crash", description: "Exits the server", inputSchema: { type: "object" } },
	{ name: "grow", description: "Adds a tool", inputSchema: { type: "object" } },
];
let roots = null;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
	const message = JSON.parse(line);
	if (message.method === "notifications/initialized") {
		send({ id: "roots", method: "roots/list" });
		continue;
	}
	if (message.id === "roots") {
		roots = message.result?.roots ?? null;
		continue;
	}
	if (!("id" in message)) continue;
	if (message.method === "initialize") {
		if (process.env.MCP_FIXTURE_HANG) continue;
		send({
			id: message.id,
			result: {
				protocolVersion: "2025-06-18",
				capabilities: { tools: { listChanged: true } },
				serverInfo: { name: "p2-fixture", version: "1.0.0" },
			},
		});
	} else if (message.method === "tools/list") send({ id: message.id, result: { tools } });
	else if (message.method === "tools/call") {
		const { name, arguments: args } = message.params;
		if (name === "echo")
			send({ id: message.id, result: { content: [{ type: "text", text: `echo: ${args?.text}` }] } });
		else if (name === "whoami") {
			const vars = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("MCP_FIXTURE_")));
			const text = JSON.stringify({ pid: process.pid, ppid: process.ppid, cwd: process.cwd(), roots, vars });
			send({ id: message.id, result: { content: [{ type: "text", text }] } });
		} else if (name === "crash") {
			send({ id: message.id, result: { content: [{ type: "text", text: "bye" }] } });
			console.error("fixture crashing on purpose");
			setTimeout(() => process.exit(1), 20);
		} else if (name === "grow") {
			if (!tools.some((tool) => tool.name === "extra"))
				tools.push({ name: "extra", description: "Added later", inputSchema: { type: "object" } });
			send({ id: message.id, result: { content: [{ type: "text", text: "grown" }] } });
			send({ method: "notifications/tools/list_changed" });
		} else send({ id: message.id, result: { content: [{ type: "text", text: `no tool ${name}` }], isError: true } });
	} else if (message.method === "ping") send({ id: message.id, result: {} });
	else send({ id: message.id, error: { code: -32601, message: "not found" } });
}
