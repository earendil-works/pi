// The views' controls outside the workbench: the top bar's Annotate switch and Views sheet (the session's views, shown
// or hidden on this device, adding one), and the composer's chip for what the next message carries; opening a view and
// describing one, shared with the views' commands (commands.tsx).
import { BACKGROUND_CONTEXT, type HeldIn, liveIn } from "@p2/app/v1";
import {
	closeLayers,
	openLayer,
	PanelSideIcon,
	PencilIcon,
	Sheet,
	useComposerState,
	useObject,
	useReadable,
	useRoute,
	useSheet,
	useStatus,
} from "@p2/app/v1/web";
import { type FormEvent, useState } from "react";
import { type OpenInput, type View, Views } from "./contract.ts";
import { viewsIn } from "./layout.ts";
import { hide, setAnnotateMode, show, useAnnotateMode, useLayout } from "./layout-store.ts";

const SHEET = "views";

/**
 * The top bar's Annotate switch and, once the session has views, the Views button and the sheet it opens (as the
 * artifacts' counter, it stays out of the bar until there is something to show).
 */
export function ViewActions() {
	const route = useRoute();
	const mode = useAnnotateMode();
	const sheet = useSheet(SHEET);
	const views = useReadable(useObject(Views, route.session ? { session: route.session } : undefined)?.views);
	if (!route.session) return null;
	return (
		<>
			<button
				type="button"
				className={`icon-button views-annotate-toggle ${mode !== "off" ? "on" : ""}`}
				aria-label="Annotate"
				aria-pressed={mode !== "off"}
				title="Annotate: comment, mark for removal, draw"
				onClick={() => setAnnotateMode(mode === "off" ? "text" : "off")}
			>
				<PencilIcon />
			</button>
			{views?.length ? (
				<button
					type="button"
					className="icon-button views-toggle"
					aria-label="Views"
					title="Views"
					onClick={() => openLayer({ kind: "sheet", name: SHEET })}
				>
					<PanelSideIcon />
				</button>
			) : null}
			{sheet && <ViewsSheet session={route.session} />}
		</>
	);
}

function ViewsSheet({ session }: { session: string }) {
	const views = useObject(Views, { session });
	useStatus(views);
	const editor = liveIn(views, "editor");
	const list = useReadable(views?.views) ?? [];
	const layout = useLayout(session);
	const { fail } = useComposerState();
	const [path, setPath] = useState("");
	const [closing, setClosing] = useState<string>();
	const placed = new Set(viewsIn(layout.tree));

	const open = (input: OpenInput) =>
		editor &&
		openView(editor, session, input)
			.then(() => closeLayers())
			.catch(fail);
	const openMarkdown = (event: FormEvent) => {
		event.preventDefault();
		const file = markdownPath(path);
		if (file) void open({ kind: "markdown", item: file });
	};

	return (
		<Sheet title="Views" onClose={closeLayers} testId="views-sheet">
			<h3 className="views-sheet-head">In this session</h3>
			{list.length ? (
				<ul className="views-list">
					{list.map((view) => (
						<li key={view.id}>
							<div className="views-list-title">
								<span>{view.title}</span>
								<span className="muted">{describe(view)}</span>
							</div>
							{placed.has(view.id) && !layout.hidden.includes(view.id) ? (
								<button type="button" className="text-action" onClick={() => hide(session, view.id)}>
									Hide
								</button>
							) : (
								<button
									type="button"
									className="text-action"
									onClick={() => {
										show(session, view.id);
										closeLayers();
									}}
								>
									Show
								</button>
							)}
							{editor &&
								(closing === view.id ? (
									<button
										type="button"
										className="text-action danger"
										onClick={() => {
											setClosing(undefined);
											editor.close({ id: view.id }, BACKGROUND_CONTEXT).catch(fail);
										}}
									>
										Close for everyone
									</button>
								) : (
									<button type="button" className="text-action" onClick={() => setClosing(view.id)}>
										Close
									</button>
								))}
						</li>
					))}
				</ul>
			) : (
				<p className="empty-note">No views yet. Ask the agent for one, or add one below.</p>
			)}
			{editor && (
				<>
					<h3 className="views-sheet-head">Add</h3>
					<div className="views-add">
						<button type="button" className="text-action" onClick={() => void open({ kind: "changes" })}>
							Changes in the working tree
						</button>
						<form onSubmit={openMarkdown}>
							<input
								value={path}
								onChange={(event) => setPath(event.target.value)}
								placeholder="Markdown file, e.g. docs/notes.md"
								aria-label="Markdown file"
							/>
							<button type="submit" className="text-action" disabled={!path.trim()}>
								Open
							</button>
						</form>
					</div>
				</>
			)}
		</Sheet>
	);
}

/** Opens a view in the session (for everyone in it) and shows it in front on this device. */
export async function openView(
	editor: HeldIn<typeof Views, "editor">,
	session: string,
	input: OpenInput,
): Promise<void> {
	const { id } = await editor.open(input, BACKGROUND_CONTEXT);
	show(session, id);
}

/** A Markdown file's path as the person typed it, relative to the workspace (a leading `./` dropped); empty: none. */
export const markdownPath = (text: string): string => text.trim().replace(/^\.\//, "");

/** What a view shows, in a few words. */
export function describe(view: View): string {
	if (view.kind === "markdown") return `Markdown · ${view.item ?? ""}`;
	if (view.kind === "changes") return view.item ? `Changes · ${view.item}` : "Changes";
	const kind = view.kind === "html" || view.kind === "md" ? `Artifact · ${view.kind}` : `Plugin · ${view.kind}`;
	return view.selection && !view.selection.sent ? `${kind} · selection waiting` : kind;
}

/** In the composer: the selections and annotations the next message carries, which the person may drop. */
export function ContextChip() {
	const session = useRoute().session;
	const views = useObject(Views, session ? { session } : undefined);
	useStatus(views);
	const editor = liveIn(views, "editor");
	const list = useReadable(views?.views) ?? [];
	const notes = useReadable(views?.annotations) ?? [];
	const inline = useReadable(views?.inline) ?? [];
	const { fail } = useComposerState();
	const selections = [
		...list.filter((view) => view.selection && !view.selection.sent),
		...inline.filter((each) => !each.selection.sent),
	];
	const pending = notes.filter((annotation) => !annotation.sent).length;
	if (!editor || (!selections.length && !pending)) return null;
	const words = [
		selections.length === 1
			? `Selection in ${selections[0]?.title}`
			: selections.length
				? `${selections.length} selections`
				: "",
		pending ? `${pending} note${pending === 1 ? "" : "s"}` : "",
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<span className="chip on views-chip" title="Your next message carries these to the agent">
			<span>{words}</span>
			<button
				type="button"
				aria-label="Do not send them"
				onPointerDown={(event) => event.preventDefault()}
				onClick={() => editor.discard(BACKGROUND_CONTEXT).catch(fail)}
			>
				×
			</button>
		</span>
	);
}
