// A plain follow's attach that reports a failure, then honours its cancellation (Astra, round 4 of ERNDL-1191): run in a
// process of its own by `follow.test.ts` (an unobserved rejection ends the process). Run from packages/chord:
//   node --conditions=source --unhandled-rejections=strict test/host/fixtures/follow-cancelled-attach.ts
import { BACKGROUND_CONTEXT as ctx } from "../../../src/context/index.ts";
import { int, local, str } from "../../../src/contracts/index.ts";
import { createHost, defineFacet } from "../../../src/host/index.ts";

const Test = local("app.test", { version: 1, params: { id: str() }, members: { a: int() } });
const errors: string[] = [];
const host = createHost({ onError: (e) => errors.push(e.kind) });
await host.load(
	[
		{
			name: "@test/runtime",
			facet: defineFacet((h) =>
				h.serve(Test, (_, self) => ({
					a: self.follow(async (observer, context) => {
						observer.advance({ kind: "failed", error: new Error("attach failure") }, context);
						context.abortSignal?.throwIfAborted();
						return { value: 7, detach() {} };
					}),
				})),
			),
		},
	],
	ctx,
);
const ref = host.hold(Test, { id: "1" }, ctx);
await new Promise((resolve) => setTimeout(resolve, 20));
console.log("observed state and error reports:", ref.state.value.kind, errors);
await host.close(ctx);
