import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

describe("RpcClient input results", () => {
	// Regression test for #9803.
	it("returns prompt, steering, and follow-up dispositions", async () => {
		const client = new RpcClient();
		const send = vi.fn(async (command: { type: string }) => ({
			type: "response",
			command: command.type,
			success: true,
			data:
				command.type === "prompt"
					? { disposition: "accepted", text: "prompt" }
					: { disposition: "queued", inputId: `${command.type}-id`, text: command.type },
		}));
		(client as unknown as { send: typeof send }).send = send;

		expect(await client.prompt("prompt")).toEqual({ disposition: "accepted", text: "prompt" });
		expect(await client.steer("steer")).toEqual({ disposition: "queued", inputId: "steer-id", text: "steer" });
		expect(await client.followUp("follow_up")).toEqual({
			disposition: "queued",
			inputId: "follow_up-id",
			text: "follow_up",
		});
	});

	it("rejects an unsuccessful input command", async () => {
		const client = new RpcClient();
		(client as unknown as { send: () => Promise<unknown> }).send = async () => ({
			type: "response",
			command: "steer",
			success: false,
			error: "Input rejected",
		});
		await expect(client.steer("steer")).rejects.toThrow("Input rejected");
	});

	// Regression test for #9803.
	it("cleans up event collection when a prompt is rejected", async () => {
		const client = new RpcClient();
		(client as unknown as { send: () => Promise<unknown> }).send = async () => ({
			type: "response",
			command: "prompt",
			success: false,
			error: "Authentication required",
		});

		await expect(client.promptAndWait("prompt")).rejects.toThrow("Authentication required");
		expect((client as unknown as { eventListeners: unknown[] }).eventListeners).toHaveLength(0);
	});
});
