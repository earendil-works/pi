// The control channel between the server and a worker (slice 10 §3): JSON messages beside the link's `Uint8Array`
// frames on one IPC channel (the IPC link skips them), and errors as they cross it (`{ message, code?, reason? }`,
// never a stack or a cause).

import type { JsonValue } from "../../json.ts";
import type { Address } from "../../next/contracts/index.ts";
import { ChordError, type FailureCause, isChordError } from "../../next/data/index.ts";
import { chordErrorFromJson } from "../../next/data/internal.ts";
import type { ReloadReport } from "../../next/host/index.ts";
import type { PluginScript } from "../plugins/runtime.ts";

/** An error as it crosses: its message, and a ChordError's code and reason. */
export type CrossedError = { readonly message: string; readonly code?: string; readonly reason?: string };

/** A reload report as it crosses: its errors crossed. */
export type CrossedReport = {
	readonly plugins: ReloadReport["plugins"];
	readonly failed: readonly { readonly plugin: string; readonly error: CrossedError }[];
	readonly objects: readonly { readonly object: string; readonly kind: string; readonly cause?: CrossedCause }[];
};

/** A failure cause as it crosses. */
type CrossedCause = { readonly kind: FailureCause["kind"]; readonly error: CrossedError };

/** What the server sends a worker. */
export type ToWorker =
	| {
			readonly kind: "start";
			readonly address: Address;
			readonly start: JsonValue;
			readonly scripts: readonly PluginScript[];
			readonly lock: string;
	  }
	| { readonly kind: "shutdown" }
	| { readonly kind: "reload"; readonly scripts: readonly PluginScript[] };

/** What a worker sends the server. */
export type FromWorker =
	| { readonly kind: "started" }
	| { readonly kind: "ready"; readonly idle: boolean; readonly report: CrossedReport }
	| { readonly kind: "idle"; readonly idle: boolean }
	| { readonly kind: "fatal"; readonly error: CrossedError }
	| { readonly kind: "reloaded"; readonly report: CrossedReport }
	| { readonly kind: "reloaded"; readonly error: CrossedError };

/** `message` in its envelope, as it goes over the IPC channel. */
export function envelope(message: ToWorker | FromWorker): { readonly [ENVELOPE]: ToWorker | FromWorker } {
	return { [ENVELOPE]: message };
}

/** The envelope's key: a control message is `{ "chord.workers": message }`. */
const ENVELOPE = "chord.workers";

/**
 * The control message in an IPC message, or `undefined` for anything else (a link frame, the app's own). A trust
 * boundary in name only: both ends are the app's processes, so only the envelope is checked.
 */
export function controlOf<M extends ToWorker | FromWorker>(message: unknown): M | undefined {
	if (typeof message !== "object" || message === null || !(ENVELOPE in message)) return undefined;
	// Sent by the other end of this channel through `envelope`.
	return (message as { readonly [ENVELOPE]: M })[ENVELOPE];
}

/** `error` as it crosses. */
export function crossed(error: unknown): CrossedError {
	if (isChordError(error)) {
		return {
			message: error.message,
			code: error.code,
			...(error.reason === undefined ? {} : { reason: error.reason }),
		};
	}
	return { message: error instanceof Error ? error.message : String(error) };
}

/** A crossed error as an error again: a ChordError when its code is one, an `Error` otherwise. */
export function uncrossed(error: CrossedError): Error {
	if (error.code === undefined) return new Error(error.message);
	try {
		return chordErrorFromJson({
			code: error.code,
			message: error.message,
			...(error.reason === undefined ? {} : { reason: error.reason }),
		});
	} catch {
		return new Error(error.message);
	}
}

/** `report` as it crosses. */
export function crossedReport(report: ReloadReport): CrossedReport {
	return {
		plugins: report.plugins,
		failed: report.failed.map(({ plugin, error }) => ({ plugin, error: crossed(error) })),
		objects: report.objects.map((each) =>
			each.kind === "parked"
				? {
						object: each.object,
						kind: each.kind,
						cause: { kind: each.cause.kind, error: crossed(each.cause.error) },
					}
				: each,
		),
	};
}

/** A crossed report as a report again. */
export function uncrossedReport(report: CrossedReport): ReloadReport {
	return {
		plugins: report.plugins,
		failed: report.failed.map(({ plugin, error }) => ({ plugin, error: uncrossed(error) })),
		objects: report.objects.map(({ object, kind, cause }) => {
			if (cause === undefined)
				return { object, kind: kind as Exclude<ReloadReport["objects"][number]["kind"], "parked"> };
			const error = uncrossed(cause.error);
			// A parked object's cause is a ChordError on the worker; one that crossed without a code is wrapped as one.
			const chord = isChordError(error) ? error : new ChordError({ code: "unavailable", message: error.message });
			return { object, kind: "parked", cause: { kind: cause.kind, error: chord } as FailureCause };
		}),
	};
}
