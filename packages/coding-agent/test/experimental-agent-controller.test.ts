import { createFacetHost, defineFacet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { InboxState, LiveState } from "@earendil-works/pi-durable";
import { describe, expect, test } from "vitest";
import { AgentController } from "../src/experimental/services/agent-controller.ts";
import { createAgentController } from "../src/experimental/services/agent-controller-provider.ts";
import { openFauxConversation, pendingResponse } from "./experimental-durable-support.ts";

describe("AgentController service", () => {
	test("prompts the root conversation through the service catalogue", async () => {
		const { harness, conversation, close } = await openFauxConversation([fauxAssistantMessage("hello back")]);
		const host = await createFacetHost({
			facets: [
				defineFacet({
					id: "test-agent-controller",
					setup(env) {
						env.provide(AgentController, createAgentController(harness, conversation));
					},
				}),
			],
		});
		try {
			expect(host.services.catalogue).toEqual([{ serviceId: AgentController.id, mode: "singleton" }]);
			const response = await host.services.invoke(
				{ serviceId: AgentController.id, member: "prompt", args: [{ message: "hello", images: null }] },
				BACKGROUND_CONTEXT,
			);
			expect(response).toEqual({ accepted: true, operationId: expect.any(String), error: null });
			const operationId = (response as { operationId: string }).operationId;
			await expect(
				host.services.invoke(
					{ serviceId: AgentController.id, member: "waitForPrompt", args: [operationId] },
					BACKGROUND_CONTEXT,
				),
			).resolves.toEqual({ status: "done", text: "hello back", reason: null });
		} finally {
			await host.dispose();
			await close();
		}
	});

	test("rejects a prompt while busy and queues steering and follow-up input", async () => {
		const pending = pendingResponse();
		const { harness, conversation, close } = await openFauxConversation([pending.step]);
		const controller = createAgentController(harness, conversation);
		try {
			const first = await controller.prompt({ message: "first", images: null }, BACKGROUND_CONTEXT);
			expect(first.accepted).toBe(true);
			await pending.reached;

			await expect(controller.prompt({ message: "second", images: null }, BACKGROUND_CONTEXT)).resolves.toEqual({
				accepted: false,
				operationId: null,
				error: { code: "busy", message: expect.stringContaining("busy") },
			});
			const steer = await controller.steer({ message: "steer", images: null }, BACKGROUND_CONTEXT);
			const followUp = await controller.followUp({ message: "later", images: null }, BACKGROUND_CONTEXT);
			expect(steer).toEqual({ accepted: true, entryId: expect.any(String), error: null });
			expect(followUp).toEqual({ accepted: true, entryId: expect.any(String), error: null });
			const inbox = await conversation.viewState(BACKGROUND_CONTEXT);
			try {
				expect((inbox.value.docs["pi.inbox"] as InboxState).items.map((item) => item.mode)).toEqual([
					"steer",
					"followUp",
				]);
			} finally {
				inbox.dispose();
			}

			if (!followUp.accepted) throw new Error("Follow-up was rejected");
			await expect(controller.cancelQueued(followUp.entryId, BACKGROUND_CONTEXT)).resolves.toEqual({
				outcome: "cancelled",
			});
			await expect(controller.cancelQueued(followUp.entryId, BACKGROUND_CONTEXT)).resolves.toEqual({
				outcome: "already_consumed",
			});
			await expect(controller.cancelQueued("999", BACKGROUND_CONTEXT)).resolves.toEqual({ outcome: "not_found" });
			await expect(controller.cancelQueued("not-an-id", BACKGROUND_CONTEXT)).resolves.toEqual({
				outcome: "not_found",
			});

			await controller.abort(BACKGROUND_CONTEXT);
			const view = await conversation.viewState(BACKGROUND_CONTEXT);
			try {
				expect((view.value.docs["pi.live"] as LiveState | undefined)?.run).toBeUndefined();
			} finally {
				view.dispose();
			}
			if (!first.accepted) throw new Error("Prompt was rejected");
			await expect(controller.waitForPrompt(first.operationId, BACKGROUND_CONTEXT)).resolves.toMatchObject({
				status: "unanswered",
				text: null,
			});
		} finally {
			await close();
		}
	});

	test("starts a compaction task", async () => {
		const { harness, conversation, close } = await openFauxConversation();
		const controller = createAgentController(harness, conversation);
		try {
			await expect(controller.compact({ customInstructions: "short" }, BACKGROUND_CONTEXT)).resolves.toEqual({
				accepted: true,
				operationId: expect.any(String),
				error: null,
			});
		} finally {
			await close();
		}
	});
});
