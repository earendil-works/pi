// The notes kind's view of one notebook in a session (`ThingViews`): its name, its notes, the last written first, with
// older ones on demand; an editor (admitted with write access and options that say `edit`) adds notes and edits and
// removes any of them, a reader only reads. The view follows the admission live: options set to read only turn it into the
// reader's at once.

import { Button, TextArea } from "@earendil-works/elanor-react";
import { BACKGROUND_CONTEXT, type Context, Me, type Reference } from "@earendil-works/p3/v1";
import { useHold, useRefState, useVariant, useWatch } from "@earendil-works/p3/v1/web";
import { useState } from "react";
import { type Author, type Note, Notes } from "./contract.ts";
import styles from "./notes-view.module.css";

/** Who is looking: a person (the owner among them) by id, or nobody known yet. */
type Viewer = { readonly id: string } | undefined;

/** The editor's methods, as the view calls them. */
type Editor = Extract<Reference<typeof Notes>, { readonly variant: "editor" }>;

/** Notebook `thing` of session `session`, as the viewer's admission allows. */
export function NotesView(props: { readonly session: string; readonly thing: string }) {
	const ref = useHold(Notes, { session: props.session, thing: props.thing });
	const editor = useVariant(ref, "editor");
	const reader = useVariant(ref, "reader");
	const state = useRefState(ref);
	const live = editor ?? reader;
	const list = useWatch(live?.list);
	const name = useWatch(live?.name);
	const me = useWatch(useVariant(useHold(Me, {}), "me")?.me);
	const action = useAction();
	const viewer: Viewer = me?.kind === "person" ? { id: me.id } : undefined;
	if (state?.kind === "failed" && state.cause.kind === "denied") {
		return <p className={styles.note}>You may not read these notes.</p>;
	}
	if (state?.kind === "failed" || state?.kind === "ended") {
		return <p className={styles.note}>These notes cannot be shown now.</p>;
	}
	return (
		<section aria-label="Notes" className={styles.notes} data-notes={live?.variant ?? "loading"}>
			<p className={styles.title} data-notes-name="">
				{name ?? "Notes"}
				{live?.variant === "reader" ? <span className={styles.readOnly}>Read only</span> : null}
			</p>
			{editor === undefined ? null : <AddNote action={action} editor={editor} />}
			{list === undefined ? (
				<p className={styles.note}>Loading…</p>
			) : list.rows.length === 0 ? (
				<p className={styles.note}>No notes yet.</p>
			) : (
				<ul className={styles.list}>
					{list.rows.map((note) => (
						<NoteItem action={action} editor={editor} key={note.id} note={note} viewer={viewer} />
					))}
				</ul>
			)}
			{live !== undefined && list?.moreAfter === true ? (
				<Button
					data-notes-more=""
					density="compact"
					hierarchy="tertiary"
					onClick={() => action.run((ctx) => live.more(ctx))}
					pending={action.pending}
				>
					Older notes
				</Button>
			) : null}
			{action.error === undefined ? null : <p className={styles.error}>{action.error}</p>}
		</section>
	);
}

/** A change the view makes (an add, an edit, a removal, older notes): whether one runs and why the last one failed. */
type Action = {
	readonly pending: boolean;
	readonly error: string | undefined;
	/** Runs `call` unless one runs already; its failure is kept as `error`, never thrown. */
	run(call: (context: Context) => Promise<unknown>): void;
};

/** The view's change state and its `run`. */
function useAction(): Action {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	return {
		pending,
		error,
		run: (call) => {
			if (pending) return;
			setPending(true);
			setError(undefined);
			call(BACKGROUND_CONTEXT).then(
				() => setPending(false),
				(failure: unknown) => {
					setPending(false);
					setError(failure instanceof Error ? failure.message : String(failure));
				},
			);
		},
	};
}

/** The editor's field for a new note and its button. */
function AddNote(props: { readonly editor: Editor; readonly action: Action }) {
	const [text, setText] = useState("");
	const add = () => {
		const note = text.trim();
		if (note === "") return;
		props.action.run(async (ctx) => {
			await props.editor.add({ text: note }, ctx);
			setText("");
		});
	};
	return (
		<div className={styles.add}>
			<TextArea
				aria-label="New note"
				className={styles.field}
				data-note-new=""
				onValueChange={setText}
				placeholder="A new note"
				rows={2}
				value={text}
			/>
			<Button
				data-note-add=""
				disabled={text.trim() === ""}
				hierarchy="secondary"
				onClick={add}
				pending={props.action.pending}
			>
				Add
			</Button>
		</div>
	);
}

/** One note: its text, who wrote it and when; an editor edits it in place or removes it. */
function NoteItem(props: {
	readonly note: Note;
	readonly editor: Editor | undefined;
	readonly viewer: Viewer;
	readonly action: Action;
}) {
	const [editing, setEditing] = useState<string | undefined>(undefined);
	const { note, editor } = props;
	const run = (call: (editor: Editor, context: Context) => Promise<unknown>) => {
		if (editor !== undefined) props.action.run((ctx) => call(editor, ctx));
	};
	return (
		<li className={styles.item} data-note={note.id}>
			{editing === undefined || editor === undefined ? (
				<p className={styles.text} data-note-text="">
					{note.text}
				</p>
			) : (
				<TextArea
					aria-label="Note"
					className={styles.field}
					data-note-edit=""
					onValueChange={setEditing}
					rows={2}
					value={editing}
				/>
			)}
			<div className={styles.meta}>
				<span className={styles.by}>
					{authorName(note.author, props.viewer)} · {new Date(note.at).toLocaleString()}
				</span>
				{editor === undefined ? null : editing === undefined ? (
					<>
						<Button density="compact" hierarchy="tertiary" onClick={() => setEditing(note.text)}>
							Edit
						</Button>
						<Button
							data-note-remove=""
							density="compact"
							hierarchy="tertiary"
							onClick={() => run((notes, ctx) => notes.remove({ id: note.id }, ctx))}
							semantic="negative"
						>
							Delete
						</Button>
					</>
				) : (
					<>
						<Button
							data-note-save=""
							density="compact"
							disabled={editing.trim() === ""}
							hierarchy="secondary"
							onClick={() =>
								run(async (notes, ctx) => {
									await notes.edit({ id: note.id, text: editing.trim() }, ctx);
									setEditing(undefined);
								})
							}
						>
							Save
						</Button>
						<Button density="compact" hierarchy="tertiary" onClick={() => setEditing(undefined)}>
							Cancel
						</Button>
					</>
				)}
			</div>
		</li>
	);
}

/** How the view names a note's author: the viewer as "You", a person (the owner too) by name, the agent. */
function authorName(author: Author, viewer: Viewer): string {
	switch (author.kind) {
		case "person":
			return viewer?.id === author.id ? "You" : author.name;
		case "agent":
			return "The agent";
	}
}
