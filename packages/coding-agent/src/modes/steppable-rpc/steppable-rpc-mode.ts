/**
 * Steppable RPC mode: JSONL request/response protocol for durable drivers.
 *
 * Unlike normal RPC mode, this does not stream agent events on stdout. Events
 * are returned inside advance responses so the durable driver can persist them
 * transactionally with the snapshot and next action.
 */

import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { takeOverStdout, writeRawStdout } from "../../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { attachJsonlLineReader, serializeJsonLine } from "../rpc/jsonl.ts";
import type { SteppableRpcCommand, SteppableRpcResponse } from "./steppable-rpc-types.ts";

export type { SteppableRpcCommand, SteppableRpcResponse } from "./steppable-rpc-types.ts";

export async function runSteppableRpcMode(runtimeHost: AgentSessionRuntime): Promise<never> {
	takeOverStdout();
	const session = runtimeHost.session;
	let shuttingDown = false;

	const output = (obj: SteppableRpcResponse) => {
		writeRawStdout(serializeJsonLine(obj));
	};

	const success = <TCommand extends SteppableRpcCommand["type"]>(
		id: string | undefined,
		command: TCommand,
		data?: object,
	): SteppableRpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as SteppableRpcResponse;
		}
		return { id, type: "response", command, success: true, data } as SteppableRpcResponse;
	};

	const failure = (id: string | undefined, command: string, error: unknown): SteppableRpcResponse => ({
		id,
		type: "response",
		command,
		success: false,
		error: error instanceof Error ? error.message : String(error),
	});

	const shutdown = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		session.dispose();
		killTrackedDetachedChildren();
		process.exit(0);
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);

	let commandQueue = Promise.resolve();
	const handleCommand = async (line: string) => {
		let command: SteppableRpcCommand;
		try {
			command = JSON.parse(line) as SteppableRpcCommand;
		} catch (error) {
			output(failure(undefined, "parse", error));
			return;
		}

		try {
			switch (command.type) {
				case "restore":
					session.restore(command.snapshot);
					output(success(command.id, command.type, session.snapshot()));
					break;

				case "snapshot":
					output(success(command.id, command.type, session.snapshot()));
					break;

				case "advance":
					output(success(command.id, command.type, await session.advance(command.input)));
					break;

				case "execute_tool":
					output(success(command.id, command.type, await session.executeTool(command.callId)));
					break;

				case "shutdown":
					output(success(command.id, command.type));
					shutdown();
					break;
			}
		} catch (error) {
			output(failure(command.id, command.type, error));
		}
	};

	attachJsonlLineReader(process.stdin, (line) => {
		commandQueue = commandQueue.then(() => handleCommand(line));
	});

	return await new Promise<never>(() => {});
}
