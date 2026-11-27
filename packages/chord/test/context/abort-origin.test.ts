// Tests of where an abort came from (`src/context/abort-origin.ts`, ERNDL-1190): a signal Chord links to several
// sources remembers the one that aborted it first, through links of links; it keeps nothing once dropped.
import { describe, expect, it } from "vitest";
import { abortFrom, abortOrigin } from "../../src/context/abort-origin.ts";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "../../src/context/index.ts";
import { withLinkedAbortSignal } from "../../src/host/ctx.ts";
import { expectCollected } from "../support.ts";

describe("the origin of an abort", () => {
	it("is the signal itself when nothing linked it, and the first source of a linked signal", () => {
		const own = new AbortController();
		expect(abortOrigin(own.signal)).toBe(own.signal);
		const caller = new AbortController();
		const attempt = new AbortController();
		const linked = withLinkedAbortSignal(attempt.signal, withAbortSignal(caller.signal, context));
		caller.abort(new Error("cancelled"));
		attempt.abort(new Error("ended"));
		const signal = linked.context.abortSignal!;
		expect([abortOrigin(signal), signal.reason.message]).toEqual([caller.signal, "cancelled"]);
	});

	it("is followed back through a link of a link, also to a source aborted before the link was made", () => {
		const attempt = new AbortController();
		const reference = new AbortController();
		attempt.abort(new Error("ended"));
		const call = withLinkedAbortSignal(reference.signal, withAbortSignal(new AbortController().signal, context));
		const handler = withLinkedAbortSignal(attempt.signal, call.context);
		expect(abortOrigin(handler.context.abortSignal!)).toBe(attempt.signal);
		reference.abort(new Error("released"));
		const nested = withLinkedAbortSignal(new AbortController().signal, call.context);
		expect(abortOrigin(nested.context.abortSignal!)).toBe(reference.signal);
	});

	it("keeps nothing of a linked signal once it is dropped (GC)", async () => {
		const source = new AbortController();
		let linked: AbortController | undefined = new AbortController();
		const signal = new WeakRef(linked.signal);
		abortFrom(linked, source.signal);
		linked = undefined;
		await expectCollected(signal);
	});
});
