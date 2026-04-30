import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";

type RpcClientPrivate = {
	send: (command: { type: string }) => Promise<unknown>;
	getData: <T>(response: unknown) => T;
};

describe("RpcClient clone", () => {
	it("sends the clone RPC command", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const send = vi.fn(async () => ({
			type: "response",
			command: "clone",
			success: true,
			data: { cancelled: false },
		}));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => {
			return (response as { data: T }).data;
		};

		const result = await client.clone();

		expect(send).toHaveBeenCalledWith({ type: "clone" });
		expect(result).toEqual({ cancelled: false });
	});
});
