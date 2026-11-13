// The command menu's listbox: at the root the Recent group, the commands for the target by group and, while the reader
// types, the plugins' searches; on a page that page's `Body`. Below it the status: "No results" and the announced count.
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { CommandPages, CommandSearches, Commands, useOwner, useRegistry } from "../../runtime/web.tsx";
import type { Command, CommandSearch, CommandTarget } from "../../runtime/web-core.ts";
import { useCommandMenu, useCommandMenuValue } from "./context.ts";
import { highlightFirst, keepHighlight } from "./highlight.ts";
import { commandScore, rankBy } from "./match.ts";
import { Group, Row } from "./parts.tsx";
import { readRecents } from "./recents.ts";

/** The listbox; it keeps one option highlighted (highlight.ts) as rows come and go. */
export function List() {
	const { state, meta } = useCommandMenuValue();
	const depth = state.pages.length;
	useEffect(() => {
		const list = meta.list.current;
		if (!list) return;
		const observer = new MutationObserver(() => keepHighlight(list));
		observer.observe(list, { childList: true, subtree: true });
		return () => observer.disconnect();
	}, [meta]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new query or page starts again at the first option.
	useLayoutEffect(() => {
		const list = meta.list.current;
		if (!list) return;
		list.scrollTop = 0;
		highlightFirst(list);
	}, [meta, state.query, depth]);
	return (
		<div className="command-list" role="listbox" id={meta.listId} ref={meta.list} aria-label="Commands">
			{depth === 0 ? <RootList /> : <PageBody key={depth} name={state.pages[depth - 1]} />}
		</div>
	);
}

function PageBody({ name }: { name: string | undefined }) {
	const pages = useRegistry(CommandPages);
	const page = name === undefined ? undefined : pages.get(name);
	return page ? <page.Body /> : null;
}

function RootList() {
	const { target, query } = useCommandMenuValue().state;
	const commands = useRegistry(Commands);
	const searches = useRegistry(CommandSearches);
	const owner = useOwner();
	const [recents] = useState(readRecents);
	const groups = useMemo(
		() => rootGroups({ commands, searches, target, owner, query, recents }),
		[commands, searches, target, owner, query, recents],
	);
	return groups.map((group) => (
		<Group key={group.heading} heading={group.heading}>
			{group.rows.map((row) => (
				<CommandRow key={row.id} id={row.id} command={row.command} />
			))}
			{group.searches.map(([key, { Results }]) => (
				<Results key={key} />
			))}
		</Group>
	));
}

function CommandRow({ id, command }: { id: string; command: Command }) {
	const { run } = useCommandMenu();
	const { Shown } = command;
	const row = <Row title={command.title} icon={command.icon} onSelect={() => void run(id)} />;
	return Shown ? <Shown>{row}</Shown> : row;
}

type RootGroup = {
	readonly heading: string;
	order: number;
	/** Whether it has commands for the target: those groups come first. */
	targeted: boolean;
	readonly rows: { readonly id: string; readonly command: Command }[];
	readonly searches: (readonly [string, CommandSearch])[];
};

const RECENT = "Recent";

/**
 * The root's groups: without a query the Recent group, then the groups with commands for the target, then the others
 * (each by `order`, then heading), commands for the target first inside a group and those in Recent left out of it
 * (the target's own group keeps its commands for the target); with a query the same groups in the same order, holding
 * the matching commands best first and the searches, which match on their own.
 */
function rootGroups(input: {
	readonly commands: ReadonlyMap<string, Command>;
	readonly searches: ReadonlyMap<string, CommandSearch>;
	readonly target: CommandTarget | undefined;
	readonly owner: boolean;
	readonly query: string;
	readonly recents: readonly string[];
}): readonly RootGroup[] {
	const { commands, searches, target, owner, query, recents } = input;
	const shown = [...commands].filter(
		([, command]) =>
			(owner || !command.owner) &&
			(command.target === undefined || (target !== undefined && command.target.includes(target.type))),
	);
	const typing = query.trim() !== "";
	// Each group's place comes from every command shown for the target, so typing never reorders the groups; a search
	// joins a command group of its heading where it is and places only a group of its own.
	const groups = new Map<string, RootGroup>();
	const groupOf = (heading: string, order: number): RootGroup => {
		const group = groups.get(heading) ?? { heading, order, targeted: false, rows: [], searches: [] };
		group.order = Math.min(group.order, order);
		groups.set(heading, group);
		return group;
	};
	for (const [, command] of shown) groupOf(command.group, command.order).targeted ||= command.target !== undefined;
	if (typing)
		for (const [key, search] of searches)
			(groups.get(search.group) ?? groupOf(search.group, search.order)).searches.push([key, search]);
	const byId = new Map(shown);
	// A command for the target in the target's own group (headed by its kind: "Branch", "Session") stays there, at the
	// top, used or not: a row's menu leads with what it does to that row.
	const own = (command: Command) => command.target !== undefined && command.group === target?.kind;
	const recent = typing ? [] : recents.filter((id) => byId.has(id) && !own(byId.get(id)!));
	const listed = typing
		? rankBy(shown, ([, command]) => commandScore(query, command))
		: shown
				.filter(([id]) => !recent.includes(id))
				.toSorted(([, a], [, b]) => Number(b.target !== undefined) - Number(a.target !== undefined));
	// Every listed command is a shown one, so its group exists.
	for (const [id, command] of listed) groups.get(command.group)!.rows.push({ id, command });
	const sorted = [...groups.values()]
		.filter((group) => group.rows.length > 0 || group.searches.length > 0)
		.sort(
			(a, b) =>
				Number(b.targeted) - Number(a.targeted) ||
				a.order - b.order ||
				(a.heading < b.heading ? -1 : a.heading > b.heading ? 1 : 0),
		);
	if (typing) return sorted;
	// `recent` holds only ids of shown commands.
	const rows = recent.map((id) => ({ id, command: byId.get(id)! }));
	return [{ heading: RECENT, order: 0, targeted: false, rows, searches: [] }, ...sorted];
}

/** While the listbox has no option "No results" (or the open page's `empty`), and the count for screen readers. */
export function Status() {
	const { state, meta } = useCommandMenuValue();
	const pages = useRegistry(CommandPages);
	const name = state.pages.at(-1);
	const empty = (name === undefined ? undefined : pages.get(name)?.empty) ?? "No results";
	const [count, setCount] = useState<number>();
	useEffect(() => {
		const list = meta.list.current;
		if (!list) return;
		const update = () => setCount(list.querySelectorAll('[role="option"]').length);
		update();
		const observer = new MutationObserver(update);
		observer.observe(list, { childList: true, subtree: true });
		return () => observer.disconnect();
	}, [meta]);
	return (
		<>
			{count === 0 && <p className="empty-note">{empty}</p>}
			<p className="command-count" aria-live="polite">
				{count === undefined ? "" : count === 1 ? "1 result" : `${count} results`}
			</p>
		</>
	);
}
