import type { AgentLane, OperationResultRecord, SuspendedRun } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type {
	AgentController as AgentControllerService,
	AgentOperationError,
	AgentOperationResponse,
	AgentPromptRequest,
	AgentQueueResponse,
} from "./agent-controller.ts";

export function createAgentController(lane: AgentLane): AgentControllerService {
	const queue = async (
		operation: "steer" | "followUp" | "nextRun",
		request: AgentPromptRequest,
		context: Parameters<AgentControllerService["steer"]>[1],
	): Promise<AgentQueueResponse> => {
		const [message, images] = toTextPrompt(request);
		const result = await lane[operation](message, images, context);
		return result.ok
			? { accepted: true, entryId: result.value.entryId, error: null }
			: { accepted: false, entryId: null, error: toAgentError(result.error) };
	};

	return {
		async prompt(request, context) {
			const [message, images] = toTextPrompt(request);
			const result = await lane.prompt(message, images, context);
			return result.ok
				? toOperationResponse(result.value)
				: { accepted: false, operationId: operationId(result.error), error: toAgentError(result.error) };
		},
		async requestAbort(operationId, context) {
			const result = await lane.requestAbort(operationId, context);
			if (!result.ok) throw new Error(result.error.message);
		},
		steer: (request, context) => queue("steer", request, context),
		followUp: (request, context) => queue("followUp", request, context),
		nextRun: (request, context) => queue("nextRun", request, context),
		async cancelQueued(entryId, context) {
			const result = await lane.cancelQueued(entryId, context);
			if (!result.ok) throw new Error(result.error.message);
			return { outcome: result.value.kind };
		},
		async resume(context) {
			const result = await lane.resume(context);
			return result.ok
				? toOperationResponse(result.value)
				: { accepted: false, operationId: null, error: toAgentError(result.error) };
		},
		async compact(request, context) {
			const result = await lane.compact(
				request.customInstructions === null ? undefined : { customInstructions: request.customInstructions },
				context,
			);
			return result.ok
				? toOperationResponse(result.value.compaction)
				: { accepted: false, operationId: operationId(result.error), error: toAgentError(result.error) };
		},
		async navigate(request, context) {
			const result = await lane.navigateTree(
				request.targetId,
				{
					summarize: request.summarize,
					...(request.label === null ? {} : { label: request.label }),
					...(request.customInstructions === null ? {} : { customInstructions: request.customInstructions }),
				},
				context,
			);
			return result.ok
				? toOperationResponse(result.value.navigation)
				: { accepted: false, operationId: operationId(result.error), error: toAgentError(result.error) };
		},
	};
}

function toOperationResponse(value: OperationResultRecord | SuspendedRun): AgentOperationResponse {
	return {
		accepted: true,
		operationId: value.operationId,
		error:
			"status" in value && value.status === "failed" && value.error !== undefined
				? { code: value.error.code, message: value.error.message }
				: null,
	};
}

function operationId(error: { readonly _tag: string }): string | null {
	return "operationId" in error && typeof error.operationId === "string" ? error.operationId : null;
}

function toAgentError(error: { readonly _tag: string; readonly message: string }): AgentOperationError {
	const code =
		{
			LaneBusy: "lane_busy",
			InvalidMessage: "invalid_message",
			UnknownSkill: "unknown_skill",
			UnknownTemplate: "unknown_template",
			NothingToCompact: "nothing_to_compact",
			NothingToResume: "nothing_to_resume",
			InvalidNavigation: "invalid_navigation",
			UnknownTarget: "unknown_target",
			Closed: "closed",
		}[error._tag] ?? "operation_failed";
	return { code, message: error.message };
}

function toTextPrompt(request: AgentPromptRequest): [message: string, images: ImageContent[] | undefined] {
	return [request.message, request.images ?? undefined];
}
