import type { Message, ToolResultMessage } from "@kennyfrc/mu-ai";
import type {
	AfterToolResultHook,
	BeforeToolCallEvent,
	BeforeToolCallHook,
	BeforeToolCallResult,
	ContextHook,
	HookMeta,
	InputHook,
	InputHookResult,
} from "./types.js";

interface OwnedHook<T> {
	hook: T;
	meta: HookMeta;
	registeredAt: number;
}

function sortHooks<T>(hooks: Array<OwnedHook<T>>): Array<OwnedHook<T>> {
	// Higher priority first. For equal priority, preserve registration order.
	return hooks
		.slice()
		.sort((a, b) => (b.meta.priority ?? 0) - (a.meta.priority ?? 0) || a.registeredAt - b.registeredAt);
}

export class ExtensionRunner {
	private contextHooks: Array<OwnedHook<ContextHook>> = [];
	private inputHooks: Array<OwnedHook<InputHook>> = [];
	private beforeToolCallHooks: Array<OwnedHook<BeforeToolCallHook>> = [];
	private afterToolResultHooks: Array<OwnedHook<AfterToolResultHook>> = [];

	registerContext(hook: ContextHook, meta: HookMeta): void {
		this.contextHooks.push({ hook, meta, registeredAt: Date.now() });
	}

	registerInput(hook: InputHook, meta: HookMeta): void {
		this.inputHooks.push({ hook, meta, registeredAt: Date.now() });
	}

	registerBeforeToolCall(hook: BeforeToolCallHook, meta: HookMeta): void {
		this.beforeToolCallHooks.push({ hook, meta, registeredAt: Date.now() });
	}

	registerAfterToolResult(hook: AfterToolResultHook, meta: HookMeta): void {
		this.afterToolResultHooks.push({ hook, meta, registeredAt: Date.now() });
	}

	async applyContext(messages: Message[], abortSignal?: AbortSignal): Promise<Message[]> {
		let current = messages;

		for (const { hook } of sortHooks(this.contextHooks)) {
			if (abortSignal?.aborted) return current;
			try {
				const res = await hook(current, abortSignal);
				if (Array.isArray(res)) {
					current = res;
				}
			} catch {}
		}

		return current;
	}

	async applyInput(text: string, abortSignal?: AbortSignal): Promise<{ handled: boolean; text: string }> {
		let currentText = text;
		for (const { hook } of sortHooks(this.inputHooks)) {
			if (abortSignal?.aborted) return { handled: true, text: currentText };
			let res: InputHookResult | undefined;
			try {
				res = await hook(currentText);
			} catch {
				// Fail-open
				continue;
			}

			if (!res || res.type === "noop") {
				continue;
			}

			if (res.type === "handled") {
				return { handled: true, text: currentText };
			}

			if (res.type === "transform") {
				currentText = res.text;
			}
		}
		return { handled: false, text: currentText };
	}

	async applyBeforeToolCall(
		event: BeforeToolCallEvent,
	): Promise<{ blocked: boolean; reason?: string; args: unknown }> {
		let args: unknown = event.args;

		for (const { hook } of sortHooks(this.beforeToolCallHooks)) {
			let res: BeforeToolCallResult | undefined;
			try {
				res = await hook({ ...event, args });
			} catch {
				// Fail-open: ignore hook errors.
				continue;
			}

			if (!res || res.type === "noop") {
				continue;
			}

			if (res.type === "block") {
				return { blocked: true, reason: res.reason, args };
			}

			if (res.type === "patch") {
				args = res.args;
			}
		}

		return { blocked: false, args };
	}

	applyAfterToolResult(toolResult: ToolResultMessage<unknown>): ToolResultMessage<unknown> {
		let current: ToolResultMessage<unknown> = toolResult;

		for (const { hook } of sortHooks(this.afterToolResultHooks)) {
			try {
				const res = hook(current);
				if (res) {
					current = res;
				}
			} catch {}
		}

		return current;
	}

	unregisterBySourceId(sourceId: string): void {
		this.contextHooks = this.contextHooks.filter((h) => h.meta.sourceId !== sourceId);
		this.inputHooks = this.inputHooks.filter((h) => h.meta.sourceId !== sourceId);
		this.beforeToolCallHooks = this.beforeToolCallHooks.filter((h) => h.meta.sourceId !== sourceId);
		this.afterToolResultHooks = this.afterToolResultHooks.filter((h) => h.meta.sourceId !== sourceId);
	}
}
