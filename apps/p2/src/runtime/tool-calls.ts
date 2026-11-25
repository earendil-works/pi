// What every facet may read of a tool call's outcome as Durable records it.

/** Durable's error for a call a restart cut short (an unsafe tool is not run again): interrupted, not failed. */
const INTERRUPTED_ERROR = /^Tool \S+ was interrupted and may have partially run/;

/** Whether a call's error says a restart cut it short: it was interrupted, not failed. */
export const isInterruptedError = (error: unknown): boolean =>
	typeof error === "string" && INTERRUPTED_ERROR.test(error);
