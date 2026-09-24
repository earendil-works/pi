/**
 * Messages between the host (main thread) and the worker. Only primitives and
 * plain data cross; tool arguments, results, and values are JSON strings so the
 * worker never has to hand a structured object into the vm context.
 */

export interface WorkerData {
	code: string;
	toolNames: string[];
	globalNames: string[];
	prelude: string;
}

/** JSON-encoded `{ name?, message, stack? }` of an error thrown by the script. */
export type ScriptErrorJson = string;

export type WorkerToHostMessage =
	| { type: "call"; id: number; target: "tool" | "global"; name: string; args: string | undefined }
	| { type: "log"; level: string; message: string }
	| { type: "done"; ok: true; value: string | undefined }
	| { type: "done"; ok: false; error: ScriptErrorJson };

export type HostToWorkerMessage =
	/** `payload` is the JSON result when `ok`, otherwise the error message. */
	{ type: "result"; id: number; ok: boolean; payload: string | undefined };

export function isWorkerToHostMessage(value: unknown): value is WorkerToHostMessage {
	if (typeof value !== "object" || value === null) return false;
	const type = (value as { type?: unknown }).type;
	return type === "call" || type === "log" || type === "done";
}
