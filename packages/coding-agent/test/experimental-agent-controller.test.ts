import { createFacetHost, defineFacet } from "@earendil-works/chord";
import {
	type AgentLane,
	BACKGROUND_CONTEXT,
	Closed,
	type RunResult as HarnessRunResult,
	InvalidMessage,
	LaneBusy,
	UnknownSkill,
	UnknownTemplate,
} from "@earendil-works/pi-agent-core";
import { describe, expect, test, vi } from "vitest";
import { AgentController } from "../src/experimental/services/agent-controller.ts";
import { createAgentController } from "../src/experimental/services/agent-controller-provider.ts";

const admissionErrors = [
	[
		new LaneBusy({
			lane: "main",
			operationId: "operation-1",
			operationKind: "run",
			message: "busy",
		}),
		"lane_busy",
		"operation-1",
	],
	[new InvalidMessage({ lane: "main", reason: "invalid", message: "invalid" }), "invalid_message", null],
	[new UnknownSkill({ name: "skill", message: "unknown" }), "unknown_skill", null],
	[new UnknownTemplate({ name: "template", message: "unknown" }), "unknown_template", null],
	[new Closed({ message: "closed" }), "closed", null],
] as const satisfies readonly [Extract<HarnessRunResult, { ok: false }>["error"], string, string | null][];

const completed = {
	operationId: "operation-1",
	kind: "run" as const,
	status: "completed" as const,
	fromTipId: null,
	tipId: "entry-1",
	startedAt: 1,
	endedAt: 2,
};

describe("AgentController service", () => {
	test("provides the presentation-safe AgentLane command surface", async () => {
		const prompt = vi.fn(async () => ({ ok: true as const, value: completed }));
		const requestAbort = vi.fn(async () => ({
			ok: true as const,
			value: { operationId: "operation-1", newlyRequested: true, steer: [], followUp: [] },
		}));
		const steer = vi.fn(async () => ({ ok: true as const, value: { entryId: "queue-1" } }));
		const followUp = vi.fn(async () => ({ ok: true as const, value: { entryId: "queue-2" } }));
		const lane = { prompt, requestAbort, steer, followUp } as unknown as AgentLane;
		const controllerFacet = defineFacet({
			id: "test-agent-controller",
			setup(env) {
				env.provide(AgentController, createAgentController(lane));
			},
		});
		const host = await createFacetHost({ facets: [controllerFacet] });
		try {
			expect(host.services.catalogue).toEqual([{ serviceId: AgentController.id, mode: "singleton" }]);
			await expect(
				host.services.invoke(
					{ serviceId: AgentController.id, member: "prompt", args: [{ message: "hello", images: null }] },
					BACKGROUND_CONTEXT,
				),
			).resolves.toEqual({ accepted: true, operationId: "operation-1", error: null });
			await expect(
				host.services.invoke(
					{ serviceId: AgentController.id, member: "requestAbort", args: ["operation-1"] },
					BACKGROUND_CONTEXT,
				),
			).resolves.toBeUndefined();
			await expect(
				host.services.invoke(
					{ serviceId: AgentController.id, member: "steer", args: [{ message: "later", images: null }] },
					BACKGROUND_CONTEXT,
				),
			).resolves.toEqual({ accepted: true, entryId: "queue-1", error: null });
			await expect(
				host.services.invoke(
					{ serviceId: AgentController.id, member: "followUp", args: [{ message: "after", images: null }] },
					BACKGROUND_CONTEXT,
				),
			).resolves.toEqual({ accepted: true, entryId: "queue-2", error: null });
			expect(prompt).toHaveBeenCalledWith("hello", undefined, BACKGROUND_CONTEXT);
			expect(requestAbort).toHaveBeenCalledWith("operation-1", BACKGROUND_CONTEXT);
			expect(steer).toHaveBeenCalledWith("later", undefined, BACKGROUND_CONTEXT);
			expect(followUp).toHaveBeenCalledWith("after", undefined, BACKGROUND_CONTEXT);
		} finally {
			await host.dispose();
		}
	});

	test("wraps queue, resume, compaction, and navigation lane operations", async () => {
		const nextRun = vi.fn(async () => ({ ok: true as const, value: { entryId: "queue-3" } }));
		const cancelQueued = vi.fn(async () => ({ ok: true as const, value: { kind: "cancelled" as const } }));
		const resume = vi.fn(async () => ({ ok: true as const, value: completed }));
		const compact = vi.fn(async () => ({
			ok: true as const,
			value: { compaction: { ...completed, operationId: "compact-1", kind: "compaction" as const } },
		}));
		const navigateTree = vi.fn(async () => ({
			ok: true as const,
			value: { navigation: { ...completed, operationId: "navigation-1", kind: "navigation" as const } },
		}));
		const controller = createAgentController({
			nextRun,
			cancelQueued,
			resume,
			compact,
			navigateTree,
		} as unknown as AgentLane);

		await expect(controller.nextRun({ message: "next", images: null }, BACKGROUND_CONTEXT)).resolves.toEqual({
			accepted: true,
			entryId: "queue-3",
			error: null,
		});
		await expect(controller.cancelQueued("queue-3", BACKGROUND_CONTEXT)).resolves.toEqual({
			outcome: "cancelled",
		});
		await expect(controller.resume(BACKGROUND_CONTEXT)).resolves.toMatchObject({ operationId: "operation-1" });
		await expect(controller.compact({ customInstructions: "short" }, BACKGROUND_CONTEXT)).resolves.toMatchObject({
			operationId: "compact-1",
		});
		await expect(
			controller.navigate(
				{ targetId: "entry-1", summarize: true, label: "branch", customInstructions: null },
				BACKGROUND_CONTEXT,
			),
		).resolves.toMatchObject({ operationId: "navigation-1" });
		expect(nextRun).toHaveBeenCalledWith("next", undefined, BACKGROUND_CONTEXT);
		expect(cancelQueued).toHaveBeenCalledWith("queue-3", BACKGROUND_CONTEXT);
		expect(resume).toHaveBeenCalledWith(BACKGROUND_CONTEXT);
		expect(compact).toHaveBeenCalledWith({ customInstructions: "short" }, BACKGROUND_CONTEXT);
		expect(navigateTree).toHaveBeenCalledWith("entry-1", { summarize: true, label: "branch" }, BACKGROUND_CONTEXT);
	});

	test("reports accepted successful and failed operations", async () => {
		const success = createAgentController({
			prompt: async () => ({ ok: true, value: completed }),
		} as unknown as AgentLane);
		await expect(success.prompt({ message: "hello", images: null }, BACKGROUND_CONTEXT)).resolves.toEqual({
			accepted: true,
			operationId: "operation-1",
			error: null,
		});

		const failed = createAgentController({
			prompt: async () => ({
				ok: true,
				value: {
					...completed,
					operationId: "operation-2",
					status: "failed",
					error: { code: "provider", message: "failed", details: { status: 500 } },
				},
			}),
		} as unknown as AgentLane);
		await expect(failed.prompt({ message: "hello", images: null }, BACKGROUND_CONTEXT)).resolves.toEqual({
			accepted: true,
			operationId: "operation-2",
			error: { code: "provider", message: "failed" },
		});
	});

	test.each(admissionErrors)("maps admission error %# to a stable response", async (error, code, operationId) => {
		const controller = createAgentController({
			prompt: async () => ({ ok: false, error }),
		} as unknown as AgentLane);
		await expect(controller.prompt({ message: "hello", images: null }, BACKGROUND_CONTEXT)).resolves.toEqual({
			accepted: false,
			operationId,
			error: { code, message: error.message },
		});
	});
});
