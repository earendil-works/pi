// A kind used by server code as a token, typed (slice 1's carry-over): `make` makes a thing of it (its input typed by
// the kind's `create.input`; a workspace kind's through `createWorkspace`), `thingsOfKind` follows the things of it
// available in a workspace, as the server sees them (every thing there, whoever may use it).

import { type Contract, type Ctx, callerKey, type P3Principal, type Self, type Watchable } from "@earendil-works/p3/v1";
import { Gives, ThingsStore } from "./contract.server.ts";
import type { Source } from "./contract.ts";
import type { ThingKind } from "./kind.ts";
import type { DefaultsChoice } from "./workspace.ts";

/**
 * Makes a thing of `Kind` named `name` in `workspace` (a workspace of a workspace kind: under it), made by `by`, through
 * the things store (trusted server code: no Make tick is checked); answers its id.
 */
export async function make<C extends Contract, I>(
	Kind: ThingKind<C, string, I>,
	args: {
		readonly name: string;
		readonly workspace: string;
		readonly by: Source;
		readonly input?: I;
		readonly defaults?: DefaultsChoice;
	},
	ctx: Ctx<P3Principal>,
): Promise<string> {
	const store = await ctx.get(ThingsStore, {});
	const { workspace, input, defaults, ...rest } = args;
	const common = {
		kind: Kind.name,
		...rest,
		...(input === undefined ? {} : { input }),
		...(defaults === undefined ? {} : { defaults }),
	};
	return Kind.info.workspace === "no"
		? store.create({ ...common, workspace }, ctx)
		: store.createWorkspace({ ...common, parent: workspace }, ctx);
}

/**
 * The ids of the things of `Kind` available in `workspace` (linked there or from above, not hidden), live, in id
 * order; for an object of server code (`self`), which then holds each as the server (`ctx.get(Kind.contract, …)`).
 */
export function thingsOfKind<C extends Contract>(
	Kind: ThingKind<C>,
	workspace: string,
	self: Self<P3Principal>,
): Watchable<string[]> {
	const gives = self.get(Gives, { workspace, caller: callerKey({ kind: "server" }) }).answers;
	return self.derive([gives], ([answers]) =>
		Object.entries(answers)
			.filter(([thing, answer]) => answer.kind === Kind.name && thing !== workspace)
			.map(([thing]) => thing)
			.sort(),
	);
}
