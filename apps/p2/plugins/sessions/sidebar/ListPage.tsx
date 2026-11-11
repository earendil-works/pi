// A rollup's or a group's list in the main area (`Route.page`): every session, those that fell out of the rollup's
// window after the others and dimmed but still openable (as a to-do app's logbook), in groups for a rollup of groups;
// or the archived sessions, each restored on a click. Its search finds sessions and messages within the list only.
import {
	ErrorToast,
	MenuIcon,
	NavAddIcon,
	openPage,
	openSidebar,
	requestReveal,
	SearchIcon,
	SideNavigation,
	Slot,
	useScrollMemory,
} from "@p2/app/v1/web";
import { useEffect, useRef, useState } from "react";
import type { SearchResults } from "../../search/contract.ts";
import { type ListEntry, type ListPageData, type NewTarget, WINDOWS } from "./model.ts";
import { inPage, pageHref, type RowActions, SessionItem } from "./Row.tsx";

/** What the page says under its title: the window, or what the archive holds. */
function subtitle(data: ListPageData | undefined): string {
	if (!data) return "";
	if (data.archived) return "Archived sessions. Open one to restore it.";
	if (!data.window || data.window === "forever" || data.window === "none")
		return "Every session shows in the sidebar.";
	const label = WINDOWS.find((each) => each.window === data.window)?.label.toLowerCase();
	return `Sessions without activity in the last ${label} are dimmed; the sidebar shows the others.`;
}

const QUERIES_KEY = "p2-list-queries";

/** The search typed on each list page of this tab, so Back to a list shows it as it was left. */
function storedQuery(page: string): string {
	try {
		const value: unknown = JSON.parse(sessionStorage.getItem(QUERIES_KEY) ?? "{}");
		return typeof value === "object" && value !== null && page in value
			? String((value as Record<string, unknown>)[page])
			: "";
	} catch {
		return "";
	}
}

function storeQuery(page: string, query: string): void {
	try {
		const value: unknown = JSON.parse(sessionStorage.getItem(QUERIES_KEY) ?? "{}");
		const queries = typeof value === "object" && value !== null ? { ...value } : {};
		sessionStorage.setItem(QUERIES_KEY, JSON.stringify({ ...queries, [page]: query }));
	} catch {}
}

/** The server's search for `query` within `sessions`, 200 ms after the last keystroke; nothing while offline. */
function useSearch(
	query: string,
	archived: boolean,
	sessions: readonly string[],
	connected: boolean,
	onSearch: ((query: string, archived: boolean, sessions: readonly string[]) => Promise<SearchResults>) | undefined,
): SearchResults | undefined {
	const [results, setResults] = useState<SearchResults>();
	const scope = sessions.join();
	// biome-ignore lint/correctness/useExhaustiveDependencies: `scope` stands for `sessions` by value; a new array of the same sessions must not search again.
	useEffect(() => {
		if (!onSearch || !connected || !query.trim()) {
			setResults(undefined);
			return;
		}
		let current = true;
		const timer = setTimeout(() => {
			// A failed search (the connection dropped) leaves the last results; the next keystroke searches again.
			void onSearch(query, archived, sessions)
				.then((value) => current && setResults(value))
				.catch(() => {});
		}, 200);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [onSearch, query, archived, scope, connected]);
	return results;
}

/** The "+" that starts a session in a group (absent without `onNewIn`). */
function NewIn({ name, target, onNewIn }: { name: string; target?: NewTarget; onNewIn?: (target: NewTarget) => void }) {
	return target && onNewIn ? (
		<button
			type="button"
			className="nav-control group-new"
			aria-label={`New session in ${name}`}
			title={`New session in ${name}`}
			onClick={() => onNewIn(target)}
		>
			<NavAddIcon size={16} />
		</button>
	) : null;
}

/**
 * The page of list `page`: a top bar with the list's name, a search, then its list (`data`; undefined: the list is
 * gone). Nothing is listed while the sessions are `loading`.
 */
export function ListPage({
	page,
	data,
	loading,
	connected,
	actions,
	onSearch,
	onNewIn,
}: {
	page: string;
	data: ListPageData | undefined;
	loading: boolean;
	connected: boolean;
	actions: RowActions;
	/** Searches titles and messages within the given sessions (absent: no search). */
	onSearch?: (query: string, archived: boolean, sessions: readonly string[]) => Promise<SearchResults>;
	/** Starts a new session in a group (the owner's). */
	onNewIn?: (target: NewTarget) => void;
}) {
	const archived = data?.archived ?? false;
	const [query, setQuery] = useState(() => storedQuery(page));
	const body = useRef<HTMLDivElement>(null);
	useScrollMemory(body, `list:${page}`);
	const content = data?.content;
	const listed =
		content?.layout === "groups"
			? content.groups.flatMap((group) => group.entries.map(({ row }) => row.id))
			: (content?.entries.map(({ row }) => row.id) ?? []);
	const results = useSearch(query, archived, listed, connected, onSearch);
	const matching = (entries: readonly ListEntry[]) =>
		results ? entries.filter(({ row }) => results.sessions.includes(row.id)) : entries;
	const messages = results?.messages ?? [];
	// The aged sessions follow the others in the secondary colour, as a to-do app's logbook below its open to-dos.
	const rows = (entries: readonly ListEntry[]) => (
		<SideNavigation.List>
			{matching(entries).map(({ row, aged }) => (
				<SessionItem
					key={row.id}
					session={row}
					scope="page"
					listsConversations={false}
					archived={archived}
					aged={aged}
					actions={actions}
				/>
			))}
		</SideNavigation.List>
	);
	const found = results && listed.some((id) => results.sessions.includes(id));
	return (
		<div className="list-page">
			<header className="topbar">
				<button type="button" className="icon-button menu sidebar-open" onClick={openSidebar} aria-label="Sessions">
					<MenuIcon />
					<Slot name="menu-badge" />
				</button>
				<div className="title">
					<h1>{data?.name ?? "Sessions"}</h1>
					<p className="list-page-subtitle">{subtitle(data)}</p>
				</div>
				{data && <NewIn name={data.name} target={data.target} onNewIn={onNewIn} />}
			</header>
			<ErrorToast />
			{/* One scroller across the main area, as the transcript's; the list in the transcript's column. */}
			<div className="scroller list-page-scroller" ref={body}>
				<div className="list-page-body" hidden={loading}>
					{data && onSearch && (
						<label className="search">
							<SearchIcon />
							<input
								type="search"
								value={query}
								onChange={(event) => {
									setQuery(event.target.value);
									storeQuery(page, event.target.value);
								}}
								placeholder={archived ? "Search the archive" : `Search ${data.name}`}
								aria-label="Search sessions and messages"
							/>
						</label>
					)}
					{content?.layout === "sessions" && rows(content.entries)}
					{content?.layout === "groups" &&
						content.groups.map((group) =>
							results && matching(group.entries).length === 0 ? null : (
								<section className="list-group" key={group.key}>
									<h2 className="list-group-label">
										{/* A group's own list: the sidebar's group rows show or hide their sessions instead. */}
										<a
											className="list-group-link"
											href={pageHref(group.key)}
											onClick={inPage(() => openPage(group.key))}
										>
											{group.name}
										</a>
										<NewIn name={group.name} target={group.target} onNewIn={onNewIn} />
									</h2>
									{group.entries.length > 0 ? rows(group.entries) : <p className="empty-note">No sessions</p>}
								</section>
							),
						)}
					{messages.length > 0 && (
						<section className="list-group">
							<h2 className="list-group-label">Messages</h2>
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
					{data && listed.length === 0 && content?.layout === "sessions" && (
						<p className="empty-note">No sessions</p>
					)}
					{results && !found && messages.length === 0 && <p className="empty-note">Nothing found</p>}
					{!data && <p className="empty-note">This list no longer exists</p>}
				</div>
			</div>
		</div>
	);
}
