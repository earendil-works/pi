import type {
	AgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";
import type {
	ErrorResponse,
	InstanceSummary,
	ListRequest,
	ListResponse,
	OrchestratorRequest,
	OrchestratorResponse,
	RpcBridgeResponse,
	RpcReadyResponse,
	RpcRequest,
	RpcStreamRequest,
	SpawnRequest,
	SpawnResponse,
	StatusRequest,
	StatusResponse,
	StopRequest,
	StopResponse,
} from "./ipc/protocol.ts";
import { supervisor } from "./supervisor.ts";
import type { InstanceRecord } from "./types.ts";

function toInstanceSummary(instance: InstanceRecord): InstanceSummary {
	return {
		id: instance.id,
		status: instance.status,
		cwd: instance.cwd,
		label: instance.label,
		sessionId: instance.sessionId,
		sessionFile: instance.sessionFile,
		radiusPiId: instance.radiusPiId,
	};
}

function unknownInstanceError(instanceId: string): ErrorResponse {
	return {
		type: "error",
		ok: false,
		error: `Unknown instance: ${instanceId}`,
	};
}

// Overhead types
export async function handleIpcRequest(request: SpawnRequest): Promise<SpawnResponse | ErrorResponse>;
export async function handleIpcRequest(request: ListRequest): Promise<ListResponse | ErrorResponse>;
export async function handleIpcRequest(request: StopRequest): Promise<StopResponse | ErrorResponse>;
export async function handleIpcRequest(request: StatusRequest): Promise<StatusResponse | ErrorResponse>;
export async function handleIpcRequest(request: RpcRequest): Promise<RpcBridgeResponse | ErrorResponse>;
export async function handleIpcRequest(request: RpcStreamRequest): Promise<RpcReadyResponse | ErrorResponse>;
export async function handleIpcRequest(request: OrchestratorRequest): Promise<OrchestratorResponse>;
export async function handleIpcRequest(request: OrchestratorRequest): Promise<OrchestratorResponse> {
	switch (request.type) {
		case "spawn": {
			const instance = await supervisor.spawnInstance({
				cwd: request.cwd,
				label: request.label,
			});
			return {
				type: "spawn_result",
				ok: true,
				instance: toInstanceSummary(instance),
			};
		}

		case "list": {
			return {
				type: "list_result",
				ok: true,
				instances: supervisor.listInstances().map(toInstanceSummary),
			};
		}

		case "status": {
			const instance = supervisor.getInstance(request.instanceId);
			if (!instance) {
				return unknownInstanceError(request.instanceId);
			}

			return {
				type: "status_result",
				ok: true,
				instance: toInstanceSummary(instance),
			};
		}

		case "stop": {
			const instance = await supervisor.stopInstance(request.instanceId);
			if (!instance) {
				return unknownInstanceError(request.instanceId);
			}

			return {
				type: "stop_result",
				ok: true,
				instanceId: request.instanceId,
			};
		}

		case "rpc": {
			const response = await supervisor.handleRpc(request.instanceId, request.command);
			if (!response) {
				return unknownInstanceError(request.instanceId);
			}

			return {
				type: "rpc_result",
				ok: true,
				response,
			};
		}

		case "rpc_stream": {
			const instance = supervisor.getInstance(request.instanceId);
			if (!instance) {
				return unknownInstanceError(request.instanceId);
			}
			return {
				type: "rpc_ready",
				ok: true,
				instance: toInstanceSummary(instance),
			};
		}
	}
}

export function openRpcStream(
	instanceId: string,
	onResponse: (response: RpcResponse) => void,
	onSessionEvent: (event: AgentSessionEvent) => void,
	onUiRequest: (request: RpcExtensionUIRequest) => void,
):
	| {
			handleRequest(request: RpcCommand | RpcExtensionUIResponse): Promise<void>;
			close(): void;
	  }
	| undefined {
	const handle = supervisor.openRpcStream(instanceId, onSessionEvent, onUiRequest);
	if (!handle) {
		return undefined;
	}

	return {
		async handleRequest(request): Promise<void> {
			if (request.type === "extension_ui_response") {
				handle.handleUiResponse(request);
				return;
			}
			const response = await handle.handleRpc(request);
			onResponse(response);
		},
		close(): void {
			handle.close();
		},
	};
}
