import type { CommittedListAppendWrite, CommittedValueSetWrite } from "./commit.ts";

export type ForkCurrentStatePlan =
	| { scope: "branch"; branch: string; destinationTip: string | null }
	| { scope: "tree" };

/** Project one current scalar row or surviving list element into destination state. */
export function projectForkCurrentStateWrite(
	write: CommittedValueSetWrite | CommittedListAppendWrite,
	plan: ForkCurrentStatePlan,
	isEntryCopied: (entryId: string) => boolean,
): CommittedValueSetWrite | CommittedListAppendWrite | undefined {
	switch (write.namespace) {
		case "pi.session.name":
			return write;
		case "pi.entry.label":
			return isEntryCopied(write.key) ? write : undefined;
		case "pi.branch.tip":
			if (plan.scope === "tree") return write;
			return write.key === plan.branch ? { ...write, value: plan.destinationTip } : undefined;
		case "pi.lane.config":
			return plan.scope === "tree" || write.key === plan.branch ? write : undefined;
		case "pi.lane.state":
			return plan.scope === "tree" || write.key === plan.branch
				? { ...write, value: { currentOperationId: null, lastOperationId: null, inbox: [] } }
				: undefined;
		case "pi.result":
			return undefined;
	}
	if (write.namespace.startsWith("pi.op.") || write.namespace.startsWith("pi.pending.")) return undefined;
	if (write.namespace === "pi" || write.namespace.startsWith("pi.")) {
		throw new Error(`Unknown reserved fork namespace: ${write.namespace}`);
	}
	return plan.scope === "tree" ? write : undefined;
}
