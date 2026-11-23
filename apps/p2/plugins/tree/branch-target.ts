// A `/tree` branch as the command menu's target (docs/tree.md, Labels): the tree panel's branch labels are targets,
// "Rename branch…" (the sessions plugin's sheet) acts on them. Host packages only, so either plugin's web facet copies it.
import { compile, int, str, tuple } from "@earendil-works/pi-schema";
import type { CommandTarget } from "@p2/app/v1/web";

/** A branch of a session, as its command target and the rename sheet's locator name it. */
export type BranchRef = { readonly session: string; readonly conversation: number };

/** Branch `conversation` of `session` as the command menu's target: "Rename branch…" acts on it. */
export const branchTarget = (ref: BranchRef, label: string): CommandTarget => ({
	type: "branch",
	id: JSON.stringify([ref.session, ref.conversation]),
	kind: "Branch",
	label,
});

const isBranchId = compile(tuple([str(), int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })])).check;

/** The branch a target's id or the sheet's locator names; undefined for anything else (locators come from the URL). */
export function branchOf(text: string | undefined): BranchRef | undefined {
	try {
		const value: unknown = JSON.parse(text ?? "");
		if (!isBranchId(value)) return undefined;
		const [session, conversation] = value;
		return { session, conversation };
	} catch {
		return undefined;
	}
}
