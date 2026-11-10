// A rollup's or a group's list in the main area (`Route.page`): every session, those that fell out of the rollup's
// window dimmed but still openable (as a to-do app's logbook), in groups for a rollup of groups; or the archived
// sessions, each restored on a click. Its search finds sessions and messages within the list.
import { MenuIcon, requestReveal, SearchIcon, SideNavigation, setDrawer, setSidebarCollapsed } from "@p2/app/v1/web";
import { useEffect, useState } from "react";
import type { SearchResults } from "../../search/contract.ts";
import { type ListEntry, type ListPageData, WINDOWS } from "./model.ts";
import { type RowActions, SessionItem } from "./Row.tsx";

/** What the page says under its title: the window, or what the archive holds. */
function subtitle(data: ListPageData | undefined): string {
	if (!data) return "";
	if (data.archived) return "Archived sessions. Open one to restore it.";
	if (!data.window || data.window === "forever") return "Every session shows in the sidebar.";
	const label = WINDOWS.find((each) => each.window === data.window)?.label.toLowerCase();
	return `Sessions without activity in the last ${label} are dimmed; the sidebar shows the others.`;
}

/** The server's search for `query` in the archive or outside it, 200 ms after the last keystroke. */
function useSearch(
	query: string,
	archived: boolean,
	onSearch: ((query: string, archived: boolean) => Promise<SearchResults>) | undefined,
): SearchResults | undefined {
	const [results, setResults] = useState<SearchResults>();
	useEffect(() => {
		if (!onSearch || !query.trim()) {
			setResults(undefined);
			return;
		}
		let current = true;
		const timer = setTimeout(() => {
			// A failed search (the connection dropped) leaves the last results; the next keystroke searches again.
			void onSearch(query, archived)
				.then((value) => current && setResults(value))
				.catch(() => {});
		}, 200);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [onSearch, query, archived]);
	return results;
}

/**
 * The page: a top bar with the list's name, a search, then its list (`data`; undefined: the list is gone). Nothing is
 * listed while the sessions are `loading`.
 */
export function ListPage({
	data,
	loading,
	actions,
	onSearch,
}: {
	data: ListPageData | undefined;
	loading: boolean;
	actions: RowActions;
	/** Searches titles and messages (absent: no search). */
	onSearch?: (query: string, archived: boolean) => Promise<SearchResults>;
}) {
	const archived = data?.archived ?? false;
	const [query, setQuery] = useState("");
	const results = useSearch(query, archived, onSearch);
	const matching = (entries: readonly ListEntry[]) =>
		results ? entries.filter(({ row }) => results.sessions.includes(row.id)) : entries;
	const content = data?.content;
	const listed = new Set(
		content?.layout === "groups"
			? content.groups.flatMap((group) => group.entries.map(({ row }) => row.id))
			: (content?.entries.map(({ row }) => row.id) ?? []),
	);
	const messages = results?.messages.filter((hit) => listed.has(hit.session)) ?? [];
	// The aged sessions follow the others in the secondary colour, as a to-do app's logbook below its open to-dos.
	const rows = (entries: readonly ListEntry[]) => {
		const shown = matching(entries);
		return shown.length === 0 ? null : (
			<SideNavigation.List>
				{shown.map(({ row, aged }) => (
					<SessionItem key={row.id} session={row} scope="page" archived={archived} aged={aged} actions={actions} />
				))}
			</SideNavigation.List>
		);
	};
	return (
		<div className="list-page">
			<header className="topbar">
				<button
					type="button"
					className="icon-button menu sidebar-open"
					onClick={() =>
						window.matchMedia("(min-width: 900px)").matches ? setSidebarCollapsed(false) : setDrawer(true)
					}
					aria-label="Sessions"
				>
					<MenuIcon />
				</button>
				<div className="title">
					<h1>{data?.name ?? "Sessions"}</h1>
					<p className="list-page-subtitle">{subtitle(data)}</p>
				</div>
			</header>
			<div className="list-page-body" hidden={loading}>
				{onSearch && data && (
					<label className="search">
						<SearchIcon />
						<input
							type="search"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={archived ? "Search the archive" : `Search ${data.name}`}
							aria-label="Search sessions and messages"
						/>
					</label>
				)}
				<SideNavigation.Root className="sidebar-nav" aria-label={data?.name ?? "Sessions"}>
					{content?.layout === "sessions" && rows(content.entries)}
					{content?.layout === "groups" &&
						content.groups.map((group) => {
							const shown = rows(group.entries);
							return shown ? (
								<SideNavigation.Group key={group.key}>
									<SideNavigation.GroupLabel className="list-group-label">
										{group.name}
									</SideNavigation.GroupLabel>
									{shown}
								</SideNavigation.Group>
							) : null;
						})}
				</SideNavigation.Root>
				{messages.length > 0 && (
					<section className="group">
						<h3>Messages</h3>
						{messages.slice(0, 40).map((hit) => (
							<button
								type="button"
								key={`${hit.session}-${hit.entryId}`}
								className="hit"
								// p2 indexes subagent messages too: a hit opens the conversation it was found in, at the message.
								onClick={() => {
									requestReveal(hit.session, hit.conversationId, hit.entryId);
									if (archived) actions.onRestore(hit.session, hit.conversationId);
									else actions.onOpen(hit.session, hit.conversationId);
								}}
							>
								<strong>{hit.title}</strong>
								<span>{hit.text.slice(0, 160)}</span>
							</button>
						))}
					</section>
				)}
				{data && listed.size === 0 && <p className="empty-note">No sessions.</p>}
				{data &&
					results &&
					listed.size > 0 &&
					![...listed].some((id) => results.sessions.includes(id)) &&
					!messages.length && <p className="empty-note">Nothing found.</p>}
				{!data && <p className="empty-note">This list no longer exists.</p>}
			</div>
		</div>
	);
}
