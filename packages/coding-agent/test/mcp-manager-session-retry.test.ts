/**
 * Tests for McpManager session-expiry reconnect logic.
 *
 * The satellite MCP server sweeps idle sessions after ~10 minutes and
 * returns 400 "Bad Request: No valid session ID" on subsequent calls.
 * The SDK does NOT auto-reconnect, so the manager must rebuild the
 * connection and retry once. See CLAUDE.md "Satellite 远程执行原则".
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { McpManager } from "../src/core/mcp/manager.ts";

interface RequestLogEntry {
	sid: string | null;
	method: string;
	id: unknown;
}

type Behavior =
	| { kind: "ok" }
	| { kind: "expireOnce" } // first callTool after init returns 400 session expired; rest OK
	| { kind: "expireEveryCall" } // every callTool returns 400 (reconnect won't help)
	| { kind: "unrelatedError" }; // first callTool returns 400 "Method not found" (not session-related)

let behavior: Behavior = { kind: "ok" };
let requestLog: RequestLogEntry[] = [];
const sessionStorage = new Map<string, boolean>();

function resetState(): void {
	requestLog = [];
	sessionStorage.clear();
	behavior = { kind: "ok" };
}

let server: Server;
let serverUrl: string;

beforeAll(async () => {
	server = createServer((req: IncomingMessage, res: ServerResponse) => {
		void handle(req, res);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	serverUrl = `http://127.0.0.1:${port}/mcp`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
	resetState();
});

afterEach(() => {
	resetState();
});

async function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
	});
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
	res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

	if (req.method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}
	if (req.url !== "/mcp" || req.method !== "POST") {
		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("not found");
		return;
	}

	const body = await readBody(req);
	let parsed: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown } = {};
	try {
		parsed = JSON.parse(body);
	} catch {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
		return;
	}

	const sid = (req.headers["mcp-session-id"] as string | undefined) ?? null;
	const method = parsed.method ?? "";
	requestLog.push({ sid, method, id: parsed.id });

	// initialize → mint a fresh session id, register it
	if (method === "initialize") {
		const newSid = `sid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		sessionStorage.set(newSid, true);
		res.writeHead(200, { "Content-Type": "application/json", "mcp-session-id": newSid });
		res.end(
			JSON.stringify({
				jsonrpc: "2.0",
				id: parsed.id,
				result: {
					protocolVersion: "2025-03-26",
					capabilities: { tools: {} },
					serverInfo: { name: "mock", version: "0.0.0" },
				},
			}),
		);
		return;
	}

	// notifications/initialized → empty 202
	if (method === "notifications/initialized") {
		res.writeHead(202);
		res.end();
		return;
	}

	// any other method requires a known session
	if (!sid || !sessionStorage.get(sid)) {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				jsonrpc: "2.0",
				id: parsed.id ?? null,
				error: { code: -32000, message: "Bad Request: No valid session ID" },
			}),
		);
		return;
	}

	// tools/list
	if (method === "tools/list") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				jsonrpc: "2.0",
				id: parsed.id,
				result: {
					tools: [
						{
							name: "echo",
							description: "echo args",
							inputSchema: { type: "object", properties: { msg: { type: "string" } } },
						},
					],
				},
			}),
		);
		return;
	}

	// tools/call — apply behavior
	if (method === "tools/call") {
		// 1-based count of callTools seen so far (including this one)
		const callToolNumber = requestLog.filter((r) => r.method === "tools/call").length;

		if (behavior.kind === "expireOnce" && callToolNumber === 1) {
			// sweep the session so any retry also looks expired unless the
			// client rebuilt the connection
			sessionStorage.delete(sid);
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: parsed.id,
					error: { code: -32000, message: "Bad Request: No valid session ID" },
				}),
			);
			return;
		}
		if (behavior.kind === "expireEveryCall") {
			sessionStorage.delete(sid);
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: parsed.id,
					error: { code: -32000, message: "Bad Request: No valid session ID" },
				}),
			);
			return;
		}
		if (behavior.kind === "unrelatedError" && callToolNumber === 1) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: parsed.id,
					error: { code: -32601, message: "Method not found" },
				}),
			);
			return;
		}

		const args = (parsed.params as { arguments?: { msg?: string } })?.arguments ?? {};
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				jsonrpc: "2.0",
				id: parsed.id,
				result: { content: [{ type: "text", text: `echo:${args.msg ?? ""}` }] },
			}),
		);
		return;
	}

	// unknown → 200 empty
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id ?? null, result: {} }));
}

describe("McpManager session-expiry reconnect", () => {
	it("transparently reconnects and retries on 'No valid session ID'", async () => {
		behavior = { kind: "expireOnce" };
		const manager = new McpManager();

		const tools = await manager.connectServer("satellite", { url: serverUrl, token: "tok" });
		expect(tools.map((t) => t.name)).toEqual(["echo"]);

		const result = await manager.callTool("satellite", "echo", { msg: "hello" });
		const text = (result.content[0] as { text?: string } | undefined)?.text;
		expect(text).toBe("echo:hello");

		// Expect: init, tools/list, tools/call (expired), init, tools/list, tools/call (ok)
		const inits = requestLog.filter((r) => r.method === "initialize").length;
		const calls = requestLog.filter((r) => r.method === "tools/call").length;
		const lists = requestLog.filter((r) => r.method === "tools/list").length;
		expect(inits).toBe(2);
		expect(lists).toBe(2);
		expect(calls).toBe(2);

		// The two initialize calls should have gotten different session ids
		const sids = new Set(requestLog.map((r) => r.sid).filter((s): s is string => !!s));
		expect(sids.size).toBe(2);

		await manager.disconnectAll();
	});

	it("does not retry on unrelated errors", async () => {
		behavior = { kind: "unrelatedError" };
		const manager = new McpManager();

		await manager.connectServer("satellite", { url: serverUrl, token: "tok" });
		const result = await manager.callTool("satellite", "echo", { msg: "hello" });

		const errText = (result.content[0] as { text?: string } | undefined)?.text ?? "";
		expect(errText).toMatch(/^MCP error: /);
		expect(errText).toContain("Method not found");

		// Only one initialize, one callTool — no reconnect attempted
		const inits = requestLog.filter((r) => r.method === "initialize").length;
		const calls = requestLog.filter((r) => r.method === "tools/call").length;
		expect(inits).toBe(1);
		expect(calls).toBe(1);

		await manager.disconnectAll();
	});

	it("returns 'after reconnect' error when reconnect itself fails", async () => {
		behavior = { kind: "expireEveryCall" };
		const manager = new McpManager();

		await manager.connectServer("satellite", { url: serverUrl, token: "tok" });
		const result = await manager.callTool("satellite", "echo", { msg: "hello" });

		const errText = (result.content[0] as { text?: string } | undefined)?.text ?? "";
		expect(errText).toMatch(/^MCP error \(after reconnect\): /);
		expect(errText).toContain("No valid session ID");

		// One initialize + one failed retry attempt; the retry's call also gets
		// the 400, so we still see exactly one "successful" initialize.
		const inits = requestLog.filter((r) => r.method === "initialize").length;
		const calls = requestLog.filter((r) => r.method === "tools/call").length;
		expect(inits).toBeGreaterThanOrEqual(2); // initial + at least one reconnect
		expect(calls).toBeGreaterThanOrEqual(2); // original + retry attempts

		await manager.disconnectAll();
	});
});
