// Artifacts in the browser: the html and md artifact kinds (`ArtifactKinds`) and their panes (`ViewKinds`), the top
// bar's button counting every kind's items and the side panel listing them (opening one opens a view of its kind, or
// for a reader shows it in the panel), the artifact tools' activities (`artifact_show` in place), the artifact
// commands (commands.tsx), and the viewer of sent files over the chat (viewer.ts).
import { BACKGROUND_CONTEXT, contribute, defineFacet, serveKeyed } from "@p2/app/v1";
import {
	ArtifactIcon,
	type ArtifactItem,
	type ArtifactKind,
	ArtifactKinds,
	CommandPages,
	CommandSearches,
	Commands,
	closeLayers,
	closePanel,
	FileIcon,
	FilePanel,
	OpenViewer,
	openLayer,
	openPanel,
	SessionId,
	SidePanel,
	Slots,
	ToolActivities,
	useComposerState,
	useLinkHref,
	useObject,
	useRegistry,
	useRoute,
	useSidePanelShown,
	ViewerHref,
	type ViewerItem,
	ViewKinds,
} from "@p2/app/v1/web";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Views } from "../views/contract.ts";
import { ViewsPages } from "../views/contract.web.ts";
import { ARTIFACT_ACTIVITIES } from "./activity.tsx";
import { ARTIFACT_COMMANDS, ARTIFACT_PAGES, ARTIFACT_SEARCH } from "./commands.tsx";
import { HtmlPane, MdPane } from "./panes.tsx";
import "./artifacts.css";
import { type LocalItem, PANEL, showLocally, useLocalItem } from "./local-item.ts";
import { useArtifacts } from "./use-artifacts.ts";
import { viewerItem, viewerLayer } from "./viewer.ts";

/** The html and md kinds: the session's artifacts of that kind, live from `Artifacts`. */
function artifactKind(kind: "html" | "md", title: string): ArtifactKind {
	// The same array while the list is the same: consumers' effects run on changes only.
	const items = (session: string): readonly ArtifactItem[] | undefined => {
		const { list } = useArtifacts(session);
		return useMemo(
			() =>
				list?.flatMap((each) =>
					each.kind === kind ? [{ id: each.id, title: each.title, updated: each.updated }] : [],
				),
			[list, kind],
		);
	};
	return {
		title,
		icon: kind === "html" ? ArtifactIcon : FileIcon,
		useItems: items,
		useCount: (session) => items(session)?.length,
		view: kind,
		useRemove: (session) => {
			const { editor } = useArtifacts(session);
			return editor ? (id) => editor.remove({ id }, BACKGROUND_CONTEXT).then(() => undefined) : undefined;
		},
	};
}

function Content({ children }: { children?: ReactNode }) {
	const route = useRoute();
	const shown = useSidePanelShown();
	const top = route.layers.at(-1);
	const item = viewerItem(top);
	const open = (item: ViewerItem): void => openLayer(viewerLayer(item));
	// Another tab opens the item's viewer over this conversation, without this tab's other layers and panels.
	const linkHref = useLinkHref();
	const href = (session: string, item: ViewerItem): string =>
		linkHref({ session, conversation: route.conversation, layers: [viewerLayer(item)] });
	const session = route.session;
	return (
		<SessionId.Provider value={session}>
			<OpenViewer.Provider value={open}>
				<ViewerHref.Provider value={(item) => (session ? href(session, item) : undefined)}>
					{children}
					{session && route.panel === PANEL && shown && <ArtifactsPanel session={session} />}
					{session && item && (
						<FilePanel
							key={top?.kind !== "drawer" ? top?.locator : undefined}
							sessionId={session}
							file={item.file}
							onClose={closeLayers}
						/>
					)}
				</ViewerHref.Provider>
			</OpenViewer.Provider>
		</SessionId.Provider>
	);
}

/**
 * The side panel: every artifact kind's items; a row opens the item in a view of its kind, or, for a reader who may not
 * change the session's views, shows its pane here on this device (read-only).
 */
function ArtifactsPanel({ session }: { session: string }) {
	const kinds = useRegistry(ArtifactKinds);
	const local = useLocalItem(session);
	if (local) return <LocalItemPanel session={session} item={local} />;
	return <ItemList session={session} kinds={kinds} />;
}

/** The item a reader opened, in the side panel: its pane, not editable; Back returns to the list. */
function LocalItemPanel({ session, item }: { session: string; item: LocalItem }) {
	const Pane = useRegistry(ViewKinds).get(item.kind)?.Pane;
	const close = () => {
		showLocally(session, undefined);
		closePanel();
	};
	return (
		<SidePanel title={item.title} onClose={close} testId="artifact-panel">
			<div className="artifact-local" data-artifact={item.id}>
				<button type="button" className="text-action" onClick={() => showLocally(session, undefined)}>
					All artifacts
				</button>
				{Pane ? (
					<Pane
						session={session}
						item={item.id}
						inline={false}
						editable={false}
						select={() => {}}
						annotations={[]}
					/>
				) : (
					<p className="empty-note">Unknown view kind "{item.kind}"</p>
				)}
			</div>
		</SidePanel>
	);
}

/** Every kind's items, the newest first. */
function ItemList({ session, kinds }: { session: string; kinds: ReadonlyMap<string, ArtifactKind> }) {
	const [counts, setCounts] = useState<Record<string, number>>({});
	const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
	return (
		<SidePanel title="Artifacts" onClose={closePanel} testId="artifact-panel">
			{[...kinds].map(([name, kind]) => (
				<KindSection
					key={name}
					session={session}
					kind={kind}
					onCount={(count) =>
						setCounts((before) => (before[name] === count ? before : { ...before, [name]: count }))
					}
				/>
			))}
			{total === 0 && <p className="empty-note">No artifacts in this session.</p>}
		</SidePanel>
	);
}

/** One kind's items in the side panel (its own component: its hooks keep their order). */
function KindSection({
	session,
	kind,
	onCount,
}: {
	session: string;
	kind: ArtifactKind;
	onCount: (count: number) => void;
}) {
	const items = kind.useItems(session);
	const remove = kind.useRemove?.(session);
	const views = useObject(Views, { session }, { variant: "editor" });
	const viewsPage = useRegistry(ViewsPages).get("views");
	const { fail } = useComposerState();
	const count = items?.length ?? 0;
	useEffect(() => onCount(count), [count, onCount]);
	if (!items?.length) return null;
	const Icon = kind.icon;
	const Row = kind.Row;
	const open = (item: ArtifactItem) =>
		views && viewsPage
			? viewsPage
					.open(views, session, { kind: kind.view, item: item.id, title: item.title.slice(0, 120) })
					.then(() => closePanel())
					.catch(fail)
			: showLocally(session, { kind: kind.view, id: item.id, title: item.title });
	return (
		<section className="artifact-kind" data-kind={kind.view}>
			<h3 className="views-sheet-head">{kind.title}</h3>
			<div className="artifact-list">
				{items.map((item) => (
					<div className="artifact-item" key={item.id}>
						<button
							type="button"
							className="artifact-row"
							onClick={() => void open(item)}
							aria-label={`Open ${item.title}`}
						>
							{Row ? (
								<Row item={item} />
							) : (
								<>
									<Icon />
									<span>
										<strong>{item.title}</strong>
										<small>{item.id}</small>
									</span>
									<small>{new Date(item.updated).toLocaleString()}</small>
								</>
							)}
						</button>
						{remove && (
							<button
								type="button"
								className="text-action"
								aria-label={`Remove ${item.title}`}
								onClick={() => remove(item.id).catch(fail)}
							>
								Remove
							</button>
						)}
					</div>
				))}
			</div>
		</section>
	);
}

/** The top bar's button: every kind's items counted (each kind's count in a component of its own), opening the panel. */
function ArtifactButton() {
	const route = useRoute();
	const kinds = useRegistry(ArtifactKinds);
	const [counts, setCounts] = useState<Record<string, number>>({});
	const session = route.session;
	if (!session) return null;
	const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
	const open = route.panel === PANEL;
	return (
		<>
			{[...kinds].map(([name, kind]) => (
				<KindCount
					key={`${session}:${name}`}
					session={session}
					kind={kind}
					onCount={(count) =>
						setCounts((before) => (before[name] === count ? before : { ...before, [name]: count }))
					}
				/>
			))}
			{total > 0 && (
				<button
					type="button"
					className={`artifact-button ${open ? "on" : ""}`}
					aria-label={`Artifacts (${total})`}
					aria-pressed={open}
					onClick={() => (open ? closePanel() : openPanel(PANEL))}
				>
					<ArtifactIcon />
					<span>{total}</span>
				</button>
			)}
		</>
	);
}

/** One kind's count for the button. */
function KindCount({
	session,
	kind,
	onCount,
}: {
	session: string;
	kind: ArtifactKind;
	onCount: (count: number) => void;
}) {
	const count = kind.useCount(session) ?? 0;
	useEffect(() => onCount(count), [count, onCount]);
	return null;
}

export default defineFacet((host) => {
	serveKeyed(host, ArtifactKinds);
	contribute(host, "p2.web-artifacts", (self) => {
		self.contribute(Slots, { "chat-content": Content, "artifact-actions": ArtifactButton });
		self.contribute(ArtifactKinds, { html: artifactKind("html", "Pages"), md: artifactKind("md", "Documents") });
		self.contribute(ViewKinds, { html: { Pane: HtmlPane }, md: { Pane: MdPane } });
		self.contribute(ToolActivities, ARTIFACT_ACTIVITIES);
		self.contribute(Commands, ARTIFACT_COMMANDS);
		self.contribute(CommandPages, ARTIFACT_PAGES);
		self.contribute(CommandSearches, { artifacts: ARTIFACT_SEARCH });
	});
});
