// The notes kind's view of one notebook (`ThingViews`): its name, its notes, the last written first, with older ones
// on demand. A writer (granted Write) adds notes and edits and removes any of them; anyone else let in reads. The view
// follows the admission live: Write taken back turns it into the reader's at once, on the same hold.

import { Button, TextArea } from "@earendil-works/elanor-react";
import {
	BACKGROUND_CONTEXT,
	type Context,
	type MessagesOf,
	type Reference,
	type Translator,
	type With,
	withGranted,
} from "@earendil-works/p3/v1";
import { type ThingViewProps, useHold, useLive, useMessages, useRefState, useWatch } from "@earendil-works/p3/v1/web";
import { useState } from "react";
import { type Author, NOTES_WRITES, type Note, Notes } from "./contract.ts";
import { messages } from "./messages.ts";
import styles from "./notes-view.module.css";

/** A writer's members, as the view calls them. */
type Writer = With<Reference<typeof Notes>, (typeof NOTES_WRITES)[number]>;

/** The view's texts in the viewer's language. */
type Texts = Translator<"notes", MessagesOf<typeof messages>>;

/** Notebook `thing`, as the viewer's admission allows. */
export function NotesView(props: ThingViewProps) {
	// Until sessions are workspaces (slice 5) a notebook is held in the workspace named by the session's id.
	const ref = useHold(Notes, { workspace: props.session, thing: props.thing });
	const live = useLive(ref);
	const writer = withGranted(live, ...NOTES_WRITES);
	const state = useRefState(ref);
	const list = useWatch(live?.list);
	const name = useWatch(live?.name);
	const action = useAction();
	const { t } = useMessages(messages);
	if (state?.kind === "failed" && state.cause.kind === "denied") return <p className={styles.note}>{t("denied")}</p>;
	if (state?.kind === "failed" || state?.kind === "ended") return <p className={styles.note}>{t("unavailable")}</p>;
	return (
		<section
			aria-label={name || t("untitled")}
			className={styles.notes}
			data-notes={live === undefined ? "loading" : writer === undefined ? "reader" : "writer"}
		>
			<p className={styles.title} data-notes-name="">
				{name || t("untitled")}
				{live !== undefined && writer === undefined ? (
					<span className={styles.readOnly}>{t("readOnly")}</span>
				) : null}
			</p>
			{writer === undefined ? null : <AddNote action={action} writer={writer} />}
			{list === undefined ? (
				<p className={styles.note}>{t("loading")}</p>
			) : list.rows.length === 0 ? (
				<p className={styles.note}>{t("empty")}</p>
			) : (
				<ul className={styles.list}>
					{list.rows.map((note) => (
						<NoteItem action={action} key={note.id} note={note} writer={writer} />
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
					{t("older")}
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

/** The writer's field for a new note and its button. */
function AddNote(props: { readonly writer: Writer; readonly action: Action }) {
	const [text, setText] = useState("");
	const { t } = useMessages(messages);
	const add = () => {
		const note = text.trim();
		if (note === "") return;
		props.action.run(async (ctx) => {
			await props.writer.add({ text: note }, ctx);
			setText("");
		});
	};
	return (
		<div className={styles.add}>
			<TextArea
				aria-label={t("newNote")}
				className={styles.field}
				data-note-new=""
				onValueChange={setText}
				placeholder={t("newNotePlaceholder")}
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
				{t("add")}
			</Button>
		</div>
	);
}

/** One note: its text, who wrote it and when; a writer edits it in place or removes it. */
function NoteItem(props: { readonly note: Note; readonly writer: Writer | undefined; readonly action: Action }) {
	const [editing, setEditing] = useState<string | undefined>(undefined);
	const { note, writer, action } = props;
	const { t } = useMessages(messages);
	return (
		<li className={styles.item} data-note={note.id}>
			{editing === undefined || writer === undefined ? (
				<p className={styles.text} data-note-text="">
					{note.text}
				</p>
			) : (
				<TextArea
					aria-label={t("note")}
					className={styles.field}
					data-note-edit=""
					onValueChange={setEditing}
					rows={2}
					value={editing}
				/>
			)}
			<div className={styles.meta}>
				<span className={styles.by}>{t("written", authorName(note.author, t), note.at)}</span>
				{writer === undefined ? null : editing === undefined ? (
					<>
						<Button density="compact" hierarchy="tertiary" onClick={() => setEditing(note.text)}>
							{t("edit")}
						</Button>
						<Button
							data-note-remove=""
							density="compact"
							hierarchy="tertiary"
							onClick={() => action.run((ctx) => writer.remove({ id: note.id }, ctx))}
							semantic="negative"
						>
							{t("remove")}
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
								action.run(async (ctx) => {
									await writer.edit({ id: note.id, text: editing.trim() }, ctx);
									setEditing(undefined);
								})
							}
						>
							{t("save")}
						</Button>
						<Button density="compact" hierarchy="tertiary" onClick={() => setEditing(undefined)}>
							{t("cancel")}
						</Button>
					</>
				)}
			</div>
		</li>
	);
}

/** How the view names a note's author: a person by name, an agent, the Pi itself. */
function authorName(author: Author, t: Texts): string {
	switch (author.kind) {
		case "person":
			return author.name;
		case "agent":
			return t("byAgent");
		case "server":
			return t("byPi");
	}
}
