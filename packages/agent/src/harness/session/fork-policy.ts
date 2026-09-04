import type { CommittedListAppendWrite, CommittedValueSetWrite } from "./commit.ts";
import type { ForkOptions } from "./types.ts";

export type ForkCurrentStatePlan =
	| { scope: "branch"; branch: string; destinationTip: string | null }
	| { scope: "tree" };

export function selectBranchFork(
	options: Extract<ForkOptions, { scope: "branch" }>,
	source: {
		tip: string | null | undefined;
		getParent: (entryId: string) => string | null | undefined;
		selectEntry: (entryId: string) => void;
	},
): Extract<ForkCurrentStatePlan, { scope: "branch" }> {
	if (source.tip === undefined) throw new Error(`Unknown source branch: ${options.branch}`);
	const requested = options.entryId ?? source.tip;
	let found = requested === null;
	let destinationTip: string | null = null;
	let entryId = source.tip;
	while (entryId !== null) {
		const parentId = source.getParent(entryId);
		if (parentId === undefined) throw new Error(`Corrupt source branch: missing parent ${entryId}`);
		if (entryId === requested) {
			found = true;
			destinationTip = options.position === "before" ? parentId : entryId;
			if (options.position !== "before") source.selectEntry(entryId);
		} else if (found) {
			source.selectEntry(entryId);
		}
		entryId = parentId;
	}
	if (!found) {
		throw new Error(`Fork entry ${requested} is not on source branch ${JSON.stringify(options.branch)}`);
	}
	return { scope: "branch", branch: options.branch, destinationTip };
}

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
