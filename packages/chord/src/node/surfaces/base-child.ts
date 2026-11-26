// The base build's child process (`buildBase`, `bundle.ts`): it takes one request over IPC, builds the base bundle as
// the server would have, answers it (or esbuild's failure as data) with V8 serialization, and exits, taking esbuild's
// JS API's and the input reads' memory with it.

import { type BaseAnswer, type BaseRequest, buildHere } from "./bundle.ts";

process.once("message", (request: BaseRequest) => {
	void buildHere(request).then(
		(bundle) => answer({ kind: "built", bundle }),
		(error: unknown) => answer(failure(error)),
	);
});

/** Sends `message` to the server, then exits. */
function answer(message: BaseAnswer): void {
	process.send?.(message, () => process.exit(0));
}

/** `error` as data the server makes its error from again: esbuild's failure keeps its `errors` and `warnings`. */
function failure(error: unknown): BaseAnswer {
	// A trust boundary of a kind: whatever the build threw, esbuild's `BuildFailure` or another error.
	const { errors, warnings } = (typeof error === "object" && error !== null ? error : {}) as {
		readonly errors?: unknown;
		readonly warnings?: unknown;
	};
	const message = error instanceof Error ? error.message : String(error);
	return { kind: "failed", message, errors: errors ?? [], warnings: warnings ?? [] };
}
