import type { AssistantMessage, Model } from "./types.js";

export type UsageListener = (message: AssistantMessage, model: Model<any>, label?: string) => void;

const listeners: UsageListener[] = [];

/**
 * Register a global listener that fires after every LLM call completes.
 * Returns an unsubscribe function.
 */
export function addUsageListener(listener: UsageListener): () => void {
	listeners.push(listener);
	return () => {
		const idx = listeners.indexOf(listener);
		if (idx >= 0) listeners.splice(idx, 1);
	};
}

/** @internal — called by stream.ts after each stream completes. */
export function notifyUsageListeners(message: AssistantMessage, model: Model<any>, label?: string): void {
	for (const fn of listeners) {
		try {
			fn(message, model, label);
		} catch {
			// Never let listener errors break the LLM call chain
		}
	}
}
