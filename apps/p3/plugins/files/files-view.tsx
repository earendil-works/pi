// The Files view (`Views`): one folder of a machine through a workspace's Files, folders first, a page at a time; a
// search below the folder; downloads; and, with Edit, uploads (one request per file), renames and removals. It opens
// where the workspace works (`useWorkLocation`: a session's location, else this device's root). The view follows the
// reference live: Browse or Edit withheld takes their controls away at once.

import { Button, IconButton, Input } from "@earendil-works/elanor-react";
import { BACKGROUND_CONTEXT, type Context, type Reference, type With, withGranted } from "@earendil-works/p3/v1";
import {
	DeleteIcon,
	DescriptionIcon,
	EditIcon,
	FolderIcon,
	SearchIcon,
	useHold,
	useLive,
	useMessages,
	useRefState,
} from "@earendil-works/p3/v1/web";
import { type ChangeEvent, useCallback, useEffect, useState } from "react";
import { useWorkLocation } from "../environments/contract.web.tsx";
import { type ThingViewProps, useErrorText } from "../things/contract.web.tsx";
import styles from "./files-view.module.css";
import { type Entry, FILES_BROWSES, FILES_EDITS, Files, type Hit } from "./kind.ts";
import { messages } from "./messages.ts";

/** What the browser opens on: the workspace, its Files thing, a machine thing's id and an absolute folder on it. */
type BrowserProps = {
	readonly workspace: string;
	readonly thing: string;
	readonly machine: string;
	readonly folder: string;
};

/** Files with Browse, as the view calls it. */
type Reader = With<Reference<typeof Files>, "entries" | "search" | "open">;

/** Files with Edit. */
type Writer = With<Reference<typeof Files>, "upload" | "rename" | "remove">;

/** Files `props.thing` held in `props.workspace`, opened where the workspace works. */
export function FilesView(props: ThingViewProps) {
	const { t } = useMessages(messages);
	const at = useWorkLocation(props.workspace);
	if (at.kind === "loading") return <p className={styles.note}>{t("loading")}</p>;
	if (at.kind === "unreadable") return <p className={styles.note}>{t("unavailable")}</p>;
	return <Browser {...props} folder={at.folder} key={at.machine} machine={at.machine} />;
}

/** The browser on `props.folder` of `props.machine`; the person moves between folders in it. */
function Browser(props: BrowserProps) {
	const { t } = useMessages(messages);
	const ref = useHold(Files, { workspace: props.workspace, thing: props.thing });
	const live = useLive(ref);
	const state = useRefState(ref);
	const reader = withGranted(live, ...FILES_BROWSES);
	const writer = withGranted(live, ...FILES_EDITS);
	const [folder, setFolder] = useState(props.folder);
	// A change (upload, rename, removal) shows the folder anew: `changes` counts them.
	const [changes, setChanges] = useState(0);
	if (state?.kind === "failed" && state.cause.kind === "denied") return <p className={styles.note}>{t("denied")}</p>;
	if (state?.kind === "failed" || state?.kind === "ended") return <p className={styles.note}>{t("unavailable")}</p>;
	if (live === undefined) return <p className={styles.note}>{t("loading")}</p>;
	if (reader === undefined) return <p className={styles.note}>{t("denied")}</p>;
	return (
		<section aria-label={t("view")} className={styles.view} data-files={writer === undefined ? "reader" : "writer"}>
			<Folder
				folder={folder}
				key={`${folder}\n${changes}`}
				machine={props.machine}
				onChanged={() => setChanges((n) => n + 1)}
				onOpen={setFolder}
				reader={reader}
				writer={writer}
			/>
		</section>
	);
}

/** One folder: its path with Up, the search field, the entries or the hits, and the upload button. */
function Folder(props: {
	readonly folder: string;
	readonly machine: string;
	readonly reader: Reader;
	readonly writer: Writer | undefined;
	readonly onOpen: (folder: string) => void;
	readonly onChanged: () => void;
}) {
	const { t } = useMessages(messages);
	const { folder, machine, reader, writer, onChanged: changed } = props;
	const [entries, setEntries] = useState<{ readonly list: readonly Entry[]; readonly next?: string } | undefined>();
	const [hits, setHits] = useState<{ readonly list: readonly Hit[]; readonly truncated: boolean } | undefined>();
	const [query, setQuery] = useState("");
	const action = useAction();
	const { run } = action;
	useEffect(() => {
		run(async (ctx) => {
			const page = await reader.entries({ machine, path: folder }, ctx);
			setEntries({ list: page.entries, ...(page.next === undefined ? {} : { next: page.next }) });
		});
	}, [run, reader, machine, folder]);
	const more = (after: string) =>
		action.run(async (ctx) => {
			const page = await reader.entries({ machine, path: folder, after }, ctx);
			setEntries((had) => ({
				list: [...(had?.list ?? []), ...page.entries],
				...(page.next === undefined ? {} : { next: page.next }),
			}));
		});
	const search = () =>
		action.run(async (ctx) => {
			const found = await reader.search({ machine, path: folder, query: query.trim() }, ctx);
			setHits({ list: found.hits, truncated: found.truncated });
		});
	const parent = folder === "/" ? undefined : folder.slice(0, Math.max(1, folder.lastIndexOf("/")));
	return (
		<>
			<div className={styles.bar}>
				<Button
					data-files-up=""
					density="compact"
					disabled={parent === undefined}
					hierarchy="tertiary"
					onClick={() => parent !== undefined && props.onOpen(parent)}
				>
					{t("up")}
				</Button>
				<span className={styles.path} data-files-path="">
					{folder}
				</span>
				{writer === undefined ? null : (
					<Upload action={action} folder={folder} machine={machine} onDone={changed} writer={writer} />
				)}
			</div>
			<form
				className={styles.bar}
				onSubmit={(event) => {
					event.preventDefault();
					if (query.trim() !== "") search();
				}}
			>
				<Input
					aria-label={t("searchHere")}
					className={styles.grow}
					data-files-query=""
					onValueChange={setQuery}
					placeholder={t("searchHere")}
					value={query}
				/>
				<IconButton aria-label={t("search")} data-files-search="" type="submit">
					<SearchIcon />
				</IconButton>
				{hits === undefined ? null : (
					<Button density="compact" hierarchy="tertiary" onClick={() => setHits(undefined)}>
						{t("clearSearch")}
					</Button>
				)}
			</form>
			{hits !== undefined ? (
				<Hits hits={hits.list} onOpen={props.onOpen} truncated={hits.truncated} />
			) : entries === undefined ? (
				<p className={styles.note}>{t("loading")}</p>
			) : entries.list.length === 0 ? (
				<p className={styles.note}>{t("empty")}</p>
			) : (
				<ul className={styles.list}>
					{entries.list.map((entry) => (
						<EntryItem
							action={action}
							entry={entry}
							key={entry.path}
							machine={machine}
							onChanged={changed}
							onOpen={props.onOpen}
							reader={reader}
							writer={writer}
						/>
					))}
				</ul>
			)}
			{hits === undefined && entries?.next !== undefined ? (
				<Button
					data-files-more=""
					density="compact"
					hierarchy="tertiary"
					onClick={() => entries.next !== undefined && more(entries.next)}
					pending={action.pending}
				>
					{t("more")}
				</Button>
			) : null}
			{action.error === undefined ? null : (
				<p className={styles.error} data-files-error="">
					{action.error}
				</p>
			)}
		</>
	);
}

/** One entry: a folder opens on a click, a file downloads; with Write, rename and remove. */
function EntryItem(props: {
	readonly entry: Entry;
	readonly machine: string;
	readonly reader: Reader;
	readonly writer: Writer | undefined;
	readonly action: Action;
	readonly onOpen: (folder: string) => void;
	readonly onChanged: () => void;
}) {
	const { t } = useMessages(messages);
	const { entry, machine, reader, writer, action } = props;
	const [renaming, setRenaming] = useState<string | undefined>(undefined);
	const folder = entry.kind === "directory";
	const download = () =>
		action.run(async (ctx) => {
			window.location.assign((await reader.open({ machine, path: entry.path }, ctx)).url);
		});
	if (renaming !== undefined && writer !== undefined) {
		const at = entry.path.slice(0, entry.path.lastIndexOf("/") + 1);
		return (
			<li className={styles.entry} data-files-entry={entry.name}>
				<form
					className={styles.bar}
					onSubmit={(event) => {
						event.preventDefault();
						action.run(async (ctx) => {
							await writer.rename({ machine, from: entry.path, to: `${at}${renaming}` }, ctx);
							setRenaming(undefined);
							props.onChanged();
						});
					}}
				>
					<Input
						aria-label={t("rename")}
						autoFocus
						className={styles.grow}
						onValueChange={setRenaming}
						value={renaming}
					/>
					<Button density="compact" disabled={renaming.trim() === ""} type="submit">
						{t("save")}
					</Button>
					<Button density="compact" hierarchy="tertiary" onClick={() => setRenaming(undefined)}>
						{t("cancel")}
					</Button>
				</form>
			</li>
		);
	}
	return (
		<li className={styles.entry} data-files-entry={entry.name}>
			<button
				className={styles.name}
				onClick={() => (folder ? props.onOpen(entry.path) : download())}
				title={folder ? entry.path : t("download")}
				type="button"
			>
				{folder ? <FolderIcon /> : <DescriptionIcon />}
				<span>{entry.name}</span>
			</button>
			{folder ? null : <span className={styles.size}>{sizeText(entry.size)}</span>}
			{writer === undefined ? null : (
				<>
					<IconButton aria-label={t("rename")} data-files-rename="" onClick={() => setRenaming(entry.name)}>
						<EditIcon />
					</IconButton>
					<IconButton
						aria-label={t("remove")}
						data-files-remove=""
						onClick={() =>
							action.run(async (ctx) => {
								await writer.remove({ machine, path: entry.path }, ctx);
								props.onChanged();
							})
						}
					>
						<DeleteIcon />
					</IconButton>
				</>
			)}
		</li>
	);
}

/** A search's hits: a folder opens on a click, a file opens its folder. */
function Hits(props: {
	readonly hits: readonly Hit[];
	readonly truncated: boolean;
	readonly onOpen: (folder: string) => void;
}) {
	const { t } = useMessages(messages);
	if (props.hits.length === 0) return <p className={styles.note}>{t("noHits")}</p>;
	return (
		<>
			<ul className={styles.list}>
				{props.hits.map((hit) => (
					<li className={styles.entry} data-files-hit={hit.path} key={hit.path}>
						<button
							className={styles.name}
							onClick={() =>
								props.onOpen(
									hit.kind === "directory"
										? hit.path
										: hit.path.slice(0, Math.max(1, hit.path.lastIndexOf("/"))),
								)
							}
							type="button"
						>
							{hit.kind === "directory" ? <FolderIcon /> : <DescriptionIcon />}
							<span>{hit.path}</span>
						</button>
					</li>
				))}
			</ul>
			{props.truncated ? <p className={styles.note}>{t("truncated")}</p> : null}
		</>
	);
}

/** The upload button: the picked file goes into `folder` in one request, landing whole once all of it came. */
function Upload(props: {
	readonly folder: string;
	readonly machine: string;
	readonly writer: Writer;
	readonly action: Action;
	readonly onDone: () => void;
}) {
	const { t } = useMessages(messages);
	const [uploading, setUploading] = useState<string | undefined>(undefined);
	const picked = (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		event.target.value = "";
		if (file === undefined) return;
		const path = props.folder === "/" ? `/${file.name}` : `${props.folder}/${file.name}`;
		setUploading(file.name);
		props.action.run(async (ctx) => {
			try {
				const { url } = await props.writer.upload({ machine: props.machine, path }, ctx);
				const response = await fetch(url, { method: "PUT", body: file });
				if (!response.ok) throw new Error(t("uploadFailed", response.status));
				props.onDone();
			} finally {
				setUploading(undefined);
			}
		});
	};
	return (
		<label className={styles.upload} data-files-upload="">
			<input className={styles.hiddenInput} onChange={picked} type="file" />
			<span>{uploading === undefined ? t("upload") : t("uploading", uploading)}</span>
		</label>
	);
}

/** A size in bytes as people read it. */
function sizeText(size: number): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
	return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** A call the view makes: whether one runs and the text of the last failure. */
type Action = {
	readonly pending: boolean;
	readonly error: string | undefined;
	/** Runs `call`; its failure is kept as `error`, never thrown. */
	run(call: (context: Context) => Promise<unknown>): void;
};

/** The view's call state and its `run`. */
function useAction(): Action {
	const errorText = useErrorText();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const run = useCallback(
		(call: (context: Context) => Promise<unknown>) => {
			setPending(true);
			setError(undefined);
			call(BACKGROUND_CONTEXT)
				.catch((failure: unknown) => setError(errorText(failure)))
				.finally(() => setPending(false));
		},
		[errorText],
	);
	return { pending, error, run };
}
