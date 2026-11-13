// The workbench: the transcript and the session's views as panes, laid out by this device's layout (layout.ts). On
// wide screens areas sit side by side with tabs; a tab drags to another area's tabs or edge, splitters resize. On phones
// one pane shows at a time, picked from a strip of tabs. Panes are rendered as siblings in a fixed order and only
// positioned, so rearranging never remounts them (a moved frame would reload, the chat would lose its place).
import { BACKGROUND_CONTEXT, liveIn } from "@p2/app/v1";
import {
	CloseIcon,
	reportClientError,
	useComposerState,
	useObject,
	useReadable,
	useRegistry,
	useRoute,
	useStatus,
	useWide,
} from "@p2/app/v1/web";
import {
	Component,
	type CSSProperties,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { AnnotationLayer, InkLayer, useNoteHighlights } from "./annotate.tsx";
import { type Annotation, type View, Views } from "./contract.ts";
import { ViewKinds } from "./kinds.ts";
import { activate, adopt, arrange, CHAT, move, type Rect, reconcile, resize, viewsIn, type Zone } from "./layout.ts";
import { hide, setLayout, useAnnotateMode, useLayout } from "./layout-store.ts";

/** Height of an area's tab strip (and the phone's strip). */
const TABS = 36;
/** How far a pressed tab moves before it drags. */
const DRAG_START = 6;

type Drag = { view: string; x: number; y: number; moved: boolean; target?: { area: string; zone: Zone; rect: Rect } };

/** The `workbench` slot: `children` is the chat (the `main` slot), shown as the transcript's pane. */
export function Workbench({ children }: { children?: ReactNode }) {
	const session = useRoute().session;
	const views = useObject(Views, session ? { session } : undefined);
	useStatus(views);
	const editor = liveIn(views, "editor");
	const list = useReadable(views?.views);
	const annotations = useReadable(views?.annotations) ?? [];
	const layout = useLayout(session ?? "");
	const wide = useWide();
	const mode = useAnnotateMode();
	const container = useRef<HTMLDivElement>(null);
	const [box, setBox] = useState<Rect>({ x: 0, y: 0, width: 0, height: 0 });
	const [drag, setDrag] = useState<Drag>();
	const kinds = useRegistry(ViewKinds);
	const { fail } = useComposerState();

	const arrangement = useReadable(views?.arrangement);
	useEffect(() => {
		if (session && list) setLayout(session, (current) => reconcile(current, list, Date.now()));
	}, [session, list]);
	// The agent's newest arrangement, adopted once per device (after the views it names are placed).
	useEffect(() => {
		if (!session || !list || !arrangement) return;
		setLayout(session, (current) =>
			arrangement.stamp > current.arranged
				? adopt(
						current,
						arrangement,
						list.map((view) => view.id),
					)
				: current,
		);
	}, [session, list, arrangement]);

	useLayoutEffect(() => {
		const element = container.current;
		if (!element) return;
		const measure = () => setBox({ x: 0, y: 0, width: element.clientWidth, height: element.clientHeight });
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	useNoteHighlights(container, annotations);

	const byId = new Map((session ? (list ?? []) : []).map((view) => [view.id, view]));
	const placed = viewsIn(layout.tree).filter((id) => id === CHAT || byId.has(id));
	const alone = placed.length <= 1;
	// Where each pane goes, and whether it shows.
	const panes = new Map<string, { style: CSSProperties; shown: boolean }>();
	const strips: ReactNode[] = [];
	const splitters: ReactNode[] = [];
	if (alone) panes.set(CHAT, { style: { inset: 0 }, shown: true });
	else if (!wide) {
		const shown = placed.includes(layout.phone) ? layout.phone : CHAT;
		for (const id of placed)
			panes.set(id, { style: { left: 0, right: 0, top: TABS, bottom: 0 }, shown: id === shown });
		strips.push(
			<div key="phone" className="views-tabs phone" style={{ left: 0, top: 0, width: box.width, height: TABS }}>
				{placed.map((id) => (
					<button
						key={id}
						type="button"
						className={`views-tab ${id === shown ? "on" : ""}`}
						onClick={() => session && setLayout(session, (current) => ({ ...current, phone: id }))}
					>
						<span>{titleOf(id, byId)}</span>
					</button>
				))}
			</div>,
		);
	} else {
		const arranged = arrange(layout.tree, box);
		for (const { area, rect } of arranged.areas) {
			const ids = area.views.filter((id) => id === CHAT || byId.has(id));
			const active = ids.includes(area.active) ? area.active : ids[0];
			for (const id of ids)
				panes.set(id, {
					style: { left: rect.x, top: rect.y + TABS, width: rect.width, height: Math.max(0, rect.height - TABS) },
					shown: id === active,
				});
			strips.push(
				<div
					key={area.id}
					className="views-tabs"
					style={{ left: rect.x, top: rect.y, width: rect.width, height: TABS }}
					data-area={area.id}
				>
					{ids.map((id) => (
						<div
							key={id}
							role="tab"
							tabIndex={0}
							aria-selected={id === active}
							className={`views-tab ${id === active ? "on" : ""} ${drag?.moved && drag.view === id ? "dragging" : ""}`}
							onPointerDown={(event) => startDrag(event, id)}
							onKeyDown={(event) => {
								if (session && (event.key === "Enter" || event.key === " "))
									setLayout(session, (current) => ({ ...current, tree: activate(current.tree, id) }));
							}}
						>
							<span>{titleOf(id, byId)}</span>
							{id !== CHAT && (
								<button
									type="button"
									className="views-tab-close"
									aria-label={`Hide ${titleOf(id, byId)}`}
									title="Hide here (the Views sheet shows it again)"
									onPointerDown={(event) => event.stopPropagation()}
									onClick={() => session && hide(session, id)}
								>
									<CloseIcon />
								</button>
							)}
						</div>
					))}
				</div>,
			);
		}
		for (const { split, index, rect, span } of arranged.splitters)
			splitters.push(
				<div
					key={`${split.id}:${index}`}
					className={`views-splitter ${split.dir}`}
					style={
						split.dir === "row"
							? { left: rect.x - 4, top: rect.y, width: 8, height: rect.height }
							: { left: rect.x, top: rect.y - 4, width: rect.width, height: 8 }
					}
					onPointerDown={(event) => {
						event.preventDefault();
						event.currentTarget.setPointerCapture(event.pointerId);
						holdPointer(true);
					}}
					onLostPointerCapture={() => holdPointer(false)}
					onPointerMove={(event) => {
						if (!session || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
						const bounds = container.current?.getBoundingClientRect();
						if (!bounds) return;
						const share =
							split.dir === "row"
								? (event.clientX - bounds.left - span.x) / span.width
								: (event.clientY - bounds.top - span.y) / span.height;
						setLayout(session, (current) => ({ ...current, tree: resize(current.tree, split.id, index, share) }));
					}}
				/>,
			);
	}

	/**
	 * While a tab or splitter holds the pointer, frames take no pointer events: the page would get no moves or release
	 * over an out-of-process frame until the drag's cover is drawn. Set on the element at once, not through a render.
	 */
	function holdPointer(held: boolean) {
		container.current?.classList.toggle("pointer-held", held);
	}

	function startDrag(event: ReactPointerEvent<HTMLElement>, view: string) {
		if (event.button !== 0) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		holdPointer(true);
		const start = { x: event.clientX, y: event.clientY };
		const element = event.currentTarget;
		let current: Drag = { view, x: start.x, y: start.y, moved: false };
		const moveTo = (move: PointerEvent) => {
			const moved = current.moved || Math.hypot(move.clientX - start.x, move.clientY - start.y) > DRAG_START;
			current = { view, x: move.clientX, y: move.clientY, moved, ...targetAt(move.clientX, move.clientY) };
			setDrag(moved ? current : undefined);
		};
		const end = () => {
			cancel();
			if (!session) return;
			const target = current.target;
			if (!current.moved) setLayout(session, (layout) => ({ ...layout, tree: activate(layout.tree, view) }));
			else if (target)
				setLayout(session, (layout) => ({ ...layout, tree: move(layout.tree, view, target.area, target.zone) }));
		};
		const cancel = () => {
			element.removeEventListener("pointermove", moveTo);
			element.removeEventListener("pointerup", end);
			element.removeEventListener("pointercancel", cancel);
			element.removeEventListener("lostpointercapture", cancel);
			holdPointer(false);
			setDrag(undefined);
		};
		element.addEventListener("pointermove", moveTo);
		element.addEventListener("pointerup", end);
		element.addEventListener("pointercancel", cancel);
		// A capture lost without a release (the element went away) ends the drag where it is.
		element.addEventListener("lostpointercapture", cancel);
	}

	/** The area under a point of the page and where in it a view would land. */
	function targetAt(clientX: number, clientY: number): { target?: Drag["target"] } {
		const bounds = container.current?.getBoundingClientRect();
		if (!bounds) return {};
		const x = clientX - bounds.left;
		const y = clientY - bounds.top;
		const hit = arrange(layout.tree, box).areas.find(
			({ rect }) => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height,
		);
		if (!hit) return {};
		const { rect } = hit;
		const fx = (x - rect.x) / rect.width;
		const fy = (y - rect.y - TABS) / Math.max(1, rect.height - TABS);
		const zone: Zone =
			y < rect.y + TABS
				? "center"
				: fx < 0.25
					? "left"
					: fx > 0.75
						? "right"
						: fy < 0.25
							? "top"
							: fy > 0.75
								? "bottom"
								: "center";
		const shown =
			zone === "left"
				? { ...rect, width: rect.width / 2 }
				: zone === "right"
					? { ...rect, x: rect.x + rect.width / 2, width: rect.width / 2 }
					: zone === "top"
						? { ...rect, height: rect.height / 2 }
						: zone === "bottom"
							? { ...rect, y: rect.y + rect.height / 2, height: rect.height / 2 }
							: rect;
		return { target: { area: hit.area.id, zone, rect: shown } };
	}

	const viewList = session ? (list ?? []) : [];
	return (
		<div
			ref={container}
			className={`views-workbench ${alone ? "alone" : ""} ${wide ? "wide" : "narrow"}`}
			data-annotate={mode}
		>
			<div key={CHAT} className="views-pane chat-pane" data-view-pane={CHAT} {...paneAttributes(panes.get(CHAT))}>
				{children}
				<InkLayer annotations={notesOf(annotations, CHAT)} />
			</div>
			{session &&
				viewList.map((view) => {
					const pane = panes.get(view.id);
					if (!pane) return null;
					const Kind = kinds.get(view.kind)?.Pane;
					return (
						<div
							key={view.id}
							className={`views-pane kind-${view.kind}`}
							data-view-pane={view.id}
							data-view-kind={view.kind}
							data-view-title={view.title}
							{...(view.item === undefined ? {} : { "data-view-item": view.item })}
							{...paneAttributes(pane)}
						>
							{Kind ? (
								<PaneBoundary key={`${view.kind}:${kindsVersion(Kind)}`}>
									<Kind
										session={session}
										{...(view.item === undefined ? {} : { item: view.item })}
										inline={false}
										view={view}
										editable={editor !== undefined}
										annotations={notesOf(annotations, view.id)}
										select={(selection) =>
											void editor?.select({ id: view.id, selection }, BACKGROUND_CONTEXT).catch(fail)
										}
									/>
								</PaneBoundary>
							) : (
								<div className="empty-note">
									Unknown view kind "{view.kind}": no plugin of this page shows it (yet).
								</div>
							)}
							<InkLayer annotations={notesOf(annotations, view.id)} />
						</div>
					);
				})}
			{strips}
			{splitters}
			{drag?.moved && (
				<div className="views-drag-cover">
					{drag.target && (
						<div
							className="views-drop"
							style={{
								left: drag.target.rect.x,
								top: drag.target.rect.y,
								width: drag.target.rect.width,
								height: drag.target.rect.height,
							}}
						/>
					)}
					<div
						className="views-drag-label"
						style={{
							left: drag.x - (container.current?.getBoundingClientRect().left ?? 0) + 12,
							top: drag.y - (container.current?.getBoundingClientRect().top ?? 0) + 12,
						}}
					>
						{titleOf(drag.view, byId)}
					</div>
				</div>
			)}
			{session && mode !== "off" && (
				<AnnotationLayer container={container} annotations={annotations} views={viewList} editor={editor} />
			)}
		</div>
	);
}

const paneAttributes = (pane: { style: CSSProperties; shown: boolean } | undefined) => ({
	style: pane?.style ?? { inset: 0 },
	hidden: pane ? !pane.shown : false,
});

const titleOf = (id: string, views: ReadonlyMap<string, View>) => (id === CHAT ? "Chat" : (views.get(id)?.title ?? id));

const notesOf = (annotations: readonly Annotation[], view: string) =>
	annotations.filter((annotation) => annotation.view === view);

/**
 * Keeps a pane's failure in its pane: a plugin's component that throws (an agent-written one, say) shows its error
 * instead of taking the page down. A new component for the kind (its plugin reloaded) starts it afresh.
 */
class PaneBoundary extends Component<{ children: ReactNode }, { error?: string }> {
	override state: { error?: string } = {};

	static getDerivedStateFromError(error: unknown): { error: string } {
		return { error: error instanceof Error ? error.message : String(error) };
	}

	override componentDidCatch(error: unknown): void {
		reportClientError(error, "view pane");
	}

	override render() {
		return this.state.error === undefined ? (
			this.props.children
		) : (
			<div className="empty-note">This view failed: {this.state.error}</div>
		);
	}
}

/** A number per pane component: a reloaded plugin's new component remounts its panes' boundaries. */
const kindNumbers = new WeakMap<object, number>();
let kindsSeen = 0;

function kindsVersion(kind: object): number {
	const known = kindNumbers.get(kind);
	if (known !== undefined) return known;
	const number = ++kindsSeen;
	kindNumbers.set(kind, number);
	return number;
}
