/**
 * Sandboxes that need no Node built-ins: `InlineCodemodeSandbox` runs the VM on the calling thread
 * and `RemoteCodemodeSandbox` runs it in another isolate. Neither imports `node:*` modules, so this
 * entry works in Cloudflare Workers, Durable Objects, and browsers. `CodemodeSandbox`, which uses
 * worker threads, stays in the main entry.
 */
export { toCodemodeIdentifier } from "./identifier.ts";
export { CodemodeSandboxBase } from "./runtime/execution.ts";
export {
	DEFAULT_INTERRUPT_BUDGET,
	InlineCodemodeSandbox,
	type InlineCodemodeSandboxOptions,
} from "./runtime/inline.ts";
export {
	MAX_OUTPUT_CHARS,
	MAX_OUTPUT_ITEMS,
	MAX_STORE_TOTAL_CHARS,
	MAX_STORE_VALUE_CHARS,
} from "./runtime/prelude-source.ts";
export type { HostToWorkerMessage, VmStartData, WorkerToHostMessage } from "./runtime/protocol.ts";
export {
	type CodemodeRemote,
	type CodemodeRemoteExchange,
	type CodemodeRemoteMessage,
	type CodemodeRemoteReply,
	type CodemodeRemoteRequest,
	type CodemodeServeOptions,
	RemoteCodemodeSandbox,
	type RemoteCodemodeSandboxOptions,
	serveCodemodeRemote,
} from "./runtime/remote.ts";
export type {
	CodemodeCall,
	CodemodeCallStatus,
	CodemodeDeclaredGlobal,
	CodemodeDeclaredTool,
	CodemodeDuring,
	CodemodeError,
	CodemodeErrorKind,
	CodemodeExecuteOptions,
	CodemodeHostCall,
	CodemodeJsonSchema,
	CodemodeOutcome,
	CodemodeOutputItem,
	CodemodeResult,
	CodemodeRun,
	CodemodeRunOptions,
	CodemodeSandboxBaseOptions,
	CodemodeStoreWrites,
	CodemodeTool,
	CodemodeToolContext,
} from "./types.ts";
export type { CodemodeWasmModule } from "./wasm.ts";
