import type { Context } from "@earendil-works/chord";
import type { Runtime, TaskTx } from "../../../src/harness/pico3/types.ts";

declare const runtime: Runtime;
declare const context: Context;

runtime.commit((tx, _current, lineContext) => {
	const taskTx: TaskTx = tx;
	const propagated: Context = lineContext;
	void taskTx;
	void propagated;
	// @ts-expect-error ordinary task transactions do not expose core entry admission
	tx.appendEntry(1, { kind: "forged" });
	// @ts-expect-error ordinary task transactions do not expose core inbox boundaries
	tx.boundary(1, "final", undefined);
	// @ts-expect-error ordinary task transactions may read config but cannot write it
	tx.config(1).set("profile", "forged");
	// @ts-expect-error ordinary task transactions do not expose raw core documents
	tx.sticky(1);
	return null;
}, context);
