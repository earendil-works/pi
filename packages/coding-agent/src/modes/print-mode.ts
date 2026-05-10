/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 */

import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.js";
import { flushRawStdout, writeRawStdout } from "../core/output-guard.js";
import { killTrackedDetachedChildren } from "../utils/shell.js";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/**
	 * In JSON mode, omit the accumulated-state `partial` (and the wrapping
	 * `message`) fields from `message_update` delta events. The default
	 * JSON contract emits both, which makes each per-token line carry
	 * every prior token of the assistant message — turning a streaming
	 * NDJSON output into O(n²) growth. Setting this flag keeps only the
	 * `type` and the per-token delta inside `assistantMessageEvent`.
	 * Consolidated `*_end` and `message_end` events still carry full content.
	 * Ignored when `mode` is not "json".
	 */
	jsonNoPartial?: boolean;
}

/**
 * Streaming `assistantMessageEvent.type` values that carry an accumulated
 * `partial: AssistantMessage` snapshot on every emit. Stripping this field
 * (and the wrapping `message` on `message_update`) from JSON output for
 * these event types is what `--json-no-partial` does.
 */
const PARTIAL_BEARING_DELTA_TYPES: ReadonlySet<string> = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);

interface MessageUpdateLikeEvent {
	type: "message_update";
	message?: unknown;
	assistantMessageEvent?: { type?: unknown; partial?: unknown };
}

function isMessageUpdateEvent(event: unknown): event is MessageUpdateLikeEvent {
	return typeof event === "object" && event !== null && (event as { type?: unknown }).type === "message_update";
}

/**
 * Serializes a session event for `--mode json` output. When `jsonNoPartial`
 * is true and the event is a `message_update` for an accumulated-state
 * delta type (text_delta / thinking_delta / toolcall_delta), strip the
 * `assistantMessageEvent.partial` field and the wrapping `message`.
 */
export function serializeJsonEvent(event: unknown, jsonNoPartial: boolean): string {
	if (!jsonNoPartial || !isMessageUpdateEvent(event)) {
		return JSON.stringify(event);
	}
	const inner = event.assistantMessageEvent;
	const innerType = typeof inner?.type === "string" ? inner.type : "";
	if (!PARTIAL_BEARING_DELTA_TYPES.has(innerType)) {
		return JSON.stringify(event);
	}
	const { partial: _partial, ...innerStripped } = (inner ?? {}) as unknown as Record<string, unknown>;
	const { message: _message, assistantMessageEvent: _ame, ...rest } = event as unknown as Record<string, unknown>;
	return JSON.stringify({
		...rest,
		type: "message_update",
		assistantMessageEvent: innerStripped,
	});
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages, jsonNoPartial = false } = options;
	let exitCode = 0;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let disposed = false;
	const signalCleanupHandlers: Array<() => void> = [];

	const disposeRuntime = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		unsubscribe?.();
		await runtimeHost.dispose();
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void disposeRuntime().finally(() => {
					process.exit(signal === "SIGHUP" ? 129 : 143);
				});
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	registerSignalHandlers();

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions({
			commandContextActions: {
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => {
					return runtimeHost.switchSession(sessionPath, switchOptions);
				},
				reload: async () => {
					await session.reload();
				},
			},
			onError: (err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});

		unsubscribe?.();
		unsubscribe = session.subscribe((event) => {
			if (mode === "json") {
				writeRawStdout(`${serializeJsonEvent(event, jsonNoPartial)}\n`);
			}
		});
	};

	try {
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		await rebindSession();

		if (initialMessage) {
			await session.prompt(initialMessage, { images: initialImages });
		}

		for (const message of messages) {
			await session.prompt(message);
		}

		if (mode === "text") {
			const state = session.state;
			const lastMessage = state.messages[state.messages.length - 1];

			if (lastMessage?.role === "assistant") {
				const assistantMsg = lastMessage as AssistantMessage;
				if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
					console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
					exitCode = 1;
				} else {
					for (const content of assistantMsg.content) {
						if (content.type === "text") {
							writeRawStdout(`${content.text}\n`);
						}
					}
				}
			}
		}

		return exitCode;
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await disposeRuntime();
		await flushRawStdout();
	}
}
