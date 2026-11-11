// Rollups made from code (plugins/rollups) as sidebar rules: a saved rollup's last output turned into a `Rollup`, its
// session IDs resolved to the sidebar's rows (archived and unknown ones dropped), its groups' keys put under the
// rollup's key, a group's target resolved to where its "+" starts a session. Pure, as model.ts.
import type { Member, RollupEntry, RollupGroup, RollupTarget } from "../../rollups/contract.ts";
import {
	type Collected,
	type Group,
	keyPart,
	type NewTarget,
	type Rollup,
	type RollupContext,
	type SidebarRow,
} from "./model.ts";

/** The sidebar key of the rollup saved as `key`. */
export const customKey = (key: string): string => `rollup:${key}`;

/**
 * The rule of a saved rollup: what its last output collected, its window, and each member's `at` and `keep`. A rollup
 * without output yet (its first run failed, or is still running) collects nothing.
 */
export function customRollup(entry: RollupEntry): Rollup {
	const { definition, output } = entry;
	const key = customKey(definition.key);
	// A session in several groups takes the first member's time and keep: the window is the rollup's, not a group's.
	const marks = new Map<string, { at?: number; keep?: boolean }>();
	const members = (list: readonly Member[]) =>
		list.map((member) => {
			if (typeof member === "string") return member;
			if (!marks.has(member.id)) marks.set(member.id, member);
			return member.id;
		});
	const collected: CollectedIds =
		output === null
			? { layout: "sessions", members: [] }
			: output.layout === "groups"
				? { layout: "groups", groups: output.groups.map((group) => ({ group, members: members(group.members) })) }
				: { layout: output.layout, members: members(output.members) };
	return {
		key,
		name: definition.name,
		archived: false,
		prefix: `${key}:`,
		window: definition.window,
		timeOf: (row) => marks.get(row.id)?.at ?? row.updatedAt,
		keeps: (row) => marks.get(row.id)?.keep === true,
		collect: (rows, context) => resolve(key, collected, rows, context),
	};
}

/** An output with its members as IDs. */
type CollectedIds =
	| { readonly layout: "sessions" | "link"; readonly members: readonly string[] }
	| { readonly layout: "groups"; readonly groups: readonly { group: RollupGroup; members: readonly string[] }[] };

/** `collected` with its IDs as the live rows they name, under the rollup's key `key`. */
function resolve(key: string, collected: CollectedIds, rows: readonly SidebarRow[], context: RollupContext): Collected {
	const byId = new Map(rows.flatMap((row) => (row.archivedAt ? [] : [[row.id, row] as const])));
	const live = (ids: readonly string[]) => ids.flatMap((id) => byId.get(id) ?? []);
	if (collected.layout !== "groups") return { layout: collected.layout, members: live(collected.members) };
	return {
		layout: "groups",
		groups: collected.groups.map(({ group, members }): Group => {
			const target = targetOf(group.target, context);
			return {
				key: `${key}:${keyPart(group.key)}`,
				name: group.name,
				...(group.title === undefined ? {} : { title: group.title }),
				sandboxed: target?.kind === "folder" && target.env !== null && context.sandboxes.has(target.env),
				members: live(members),
				...(target ? { target } : {}),
				...(group.keep ? { keep: true } : {}),
			};
		}),
	};
}

/** Where a group's "+" starts a session: its folder, or its project when the project exists. */
function targetOf(target: RollupTarget | undefined, context: RollupContext): NewTarget | undefined {
	if (target?.kind === "folder") return target;
	const project = target && context.projects.find((each) => each.name === target.project);
	return project && { kind: "project", project };
}
