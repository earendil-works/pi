import type {
	AgentSteppableInput,
	AgentSteppableResult,
	AgentSteppableSnapshot,
	AgentSteppableToolExecutionResult,
} from "@earendil-works/pi-agent-core";

export type SteppableRpcCommand =
	| { id?: string; type: "restore"; snapshot: AgentSteppableSnapshot }
	| { id?: string; type: "snapshot" }
	| { id?: string; type: "advance"; input: AgentSteppableInput }
	| { id?: string; type: "execute_tool"; callId: string }
	| { id?: string; type: "shutdown" };

export type SteppableRpcResponse =
	| { id?: string; type: "response"; command: "restore"; success: true; data: AgentSteppableSnapshot }
	| { id?: string; type: "response"; command: "snapshot"; success: true; data: AgentSteppableSnapshot }
	| { id?: string; type: "response"; command: "advance"; success: true; data: AgentSteppableResult }
	| {
			id?: string;
			type: "response";
			command: "execute_tool";
			success: true;
			data: AgentSteppableToolExecutionResult;
	  }
	| { id?: string; type: "response"; command: "shutdown"; success: true }
	| { id?: string; type: "response"; command: string; success: false; error: string };
