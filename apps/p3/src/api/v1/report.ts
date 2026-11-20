// `reportError`: how p3's base and plugins report a failure nobody awaits (a worker that crashed, a start the waker
// could not make). For now it prints one line to stderr, which reaches `logs/server.log` for a background server (a
// worker's stderr is the server's). With the telemetry package it records the failure on `context`'s telemetry
// instead: call sites stay as they are. Browser-safe: the API module exports it.

import { isChordError } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";

/** Reports `error` of `what` (who failed doing what: "p3 runner: s1: worker"), in `context`'s work. */
export function reportError(what: string, error: unknown, _context: Context): void {
	console.error(`${new Date().toISOString()} ${what}: ${described(error)}`);
}

/**
 * `error` in one line: a Chord error by its code and message, a report object (a host's, a plugin's) as JSON with its
 * errors described, and any other error, a bug nobody expected, with its stack.
 */
function described(error: unknown): string {
	if (isChordError(error)) return `${error.code}: ${error.message}${causeOf(error)}`;
	if (error instanceof Error) return error.stack ?? error.message;
	if (typeof error !== "object" || error === null) return String(error);
	return JSON.stringify(error, (_key, value: unknown) =>
		isChordError(value) || value instanceof Error ? described(value) : value,
	);
}

/** `error`'s cause, when it has one, as " (cause: ...)". */
function causeOf(error: Error): string {
	return error.cause === undefined
		? ""
		: ` (cause: ${error.cause instanceof Error ? error.cause.message : String(error.cause)})`;
}
