// A first attachment that fails, its detach throwing (Astra, round 6 of ERNDL-1191): run in a process of its own by
// `follow.test.ts` with `plain` or `over` (an exception thrown out of a microtask ends the process). Run from
// packages/chord: node --conditions=source test/host/fixtures/follow-throwing-cleanup.ts over
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { int, local, str } from "../../../src/contracts/index.ts";
import { createHost, defineFacet, type FollowAttach } from "../../../src/host/index.ts";

const T = local("app.cleanup", { version: 1, params: { id: str() }, members: { a: int() } });
const host = createHost({ onError() {} });
await host.load(
	[
		{
			name: "@test/example",
			facet: defineFacet((h) =>
				h.serve(T, (_, self) => {
					const attach: FollowAttach<number> = async (o, c) => {
						o.advance({ kind: "failed", error: new Error("failed before settling") }, c);
						return {
							value: 7,
							detach() {
								throw new Error("cleanup threw");
							},
						};
					};
					return {
						a:
							process.argv[2] === "plain"
								? self.follow(attach)
								: self.follow(self.writable(1), (_, o, c) => attach(o, c)),
					};
				}),
			),
		},
	],
	context,
);
const ref = host.hold(T, { id: "1" }, context);
await new Promise((r) => setTimeout(r, 20));
console.log(`state=${ref.state.value.kind}`);
await host.close(context);
