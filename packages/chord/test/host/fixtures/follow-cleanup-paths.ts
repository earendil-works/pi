// The over form's three ways of giving up an observation whose detach throws (Astra, round 7 of ERNDL-1191): `stale`,
// `release` or `replace`, run in a process of its own by `follow.test.ts` (a throw escaping ends the process); prints
// what it observed as JSON. Run from packages/chord: node --conditions=source test/host/fixtures/follow-cleanup-paths.ts stale
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { int, local, str } from "../../../src/contracts/index.ts";
import { createHost, defineFacet, type FollowAttach } from "../../../src/host/index.ts";

const mode = process.argv[2];
const T = local("app.paths", { version: 1, params: { id: str() }, members: { a: int() } });
const reports: string[] = [];
const host = createHost({
	onError(e) {
		if (e.kind === "follow_failed") reports.push(`${e.kind}:${String(e.error)}`);
		else if (e.kind === "activation_failed") reports.push(`${e.kind}:${e.failure.kind}:${e.failure.error.message}`);
		else reports.push(e.kind);
	},
});
const gate = Promise.withResolvers<void>(),
	started = Promise.withResolvers<void>();
let give = (_n: number) => {};
let detached = 0;
await host.load(
	[
		{
			name: "@test/runtime",
			facet: defineFacet((h) =>
				h.serve(T, (_, self) => {
					const over = self.writable(1);
					give = (n) => over.set(n);
					const attach =
						(n: number): FollowAttach<number> =>
						async (o, c) => {
							if (n === 1) {
								started.resolve();
								if (mode === "stale") await gate.promise;
								if (mode === "plain" || mode === "over")
									o.advance({ kind: "failed", error: new Error("original activation failure") }, c);
							}
							return {
								value: n,
								detach() {
									if (n === 1) {
										detached++;
										throw new Error("cleanup failure");
									}
								},
							};
						};
					return {
						a: mode === "plain" ? self.follow(attach(1)) : self.follow(over, (n, o, c) => attach(n)(o, c)),
					};
				}),
			),
		},
	],
	context,
);
const ref = host.hold(T, { id: "1" }, context);
await started.promise;
if (mode === "stale" || mode === "replace") {
	if (mode === "replace") await host.get(T, { id: "1" }, context);
	give(2);
	await new Promise((r) => setTimeout(r, 5));
	gate.resolve();
}
await new Promise((r) => setTimeout(r, 10));
if (mode === "release") {
	ref.release();
	await new Promise((r) => setTimeout(r, 15));
}
console.log(JSON.stringify({ state: ref.state.value.kind, detached, reports }));
await host.close(context);
