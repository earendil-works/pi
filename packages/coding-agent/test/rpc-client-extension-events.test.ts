import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import type { RpcResponse } from "../src/modes/rpc/rpc-types.ts";

type RpcClientPrivate = {
	send: () => Promise<RpcResponse>;
	handleLine: (line: string) => void;
	eventListeners: unknown[];
};

describe("RpcClient extension protocol events", () => {
	it("rejects void command methods when the RPC response fails", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		privateClient.send = vi.fn(
			async (): Promise<RpcResponse> => ({
				id: "req_1",
				type: "response",
				command: "prompt",
				success: false,
				error: "command failed",
			}),
		);

		await expect(client.prompt("/explode")).rejects.toThrow("command failed");
	});

	it("promptAndWait removes its agent listener when prompt preflight fails", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		privateClient.send = vi.fn(
			async (): Promise<RpcResponse> => ({
				id: "req_1",
				type: "response",
				command: "prompt",
				success: false,
				error: "preflight failed",
			}),
		);

		await expect(client.promptAndWait("/explode", undefined, 100)).rejects.toThrow("preflight failed");
		expect(privateClient.eventListeners).toHaveLength(0);
	});

	it("keeps onEvent agent-only while onRpcEvent receives extension events", () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const agentEvents: string[] = [];
		const protocolEvents: string[] = [];
		client.onEvent((event) => agentEvents.push(event.type));
		client.onRpcEvent((event) => protocolEvents.push(event.type));

		privateClient.handleLine(
			JSON.stringify({
				type: "extension_output",
				requestId: "req_1",
				stream: "stdout",
				text: "ok\n",
			}),
		);
		privateClient.handleLine(JSON.stringify({ type: "agent_start" }));

		expect(agentEvents).toEqual(["agent_start"]);
		expect(protocolEvents).toEqual(["extension_output", "agent_start"]);
	});
});
