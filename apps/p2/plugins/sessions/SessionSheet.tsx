import { ChevronIcon, locationLabel, Sheet } from "@p2/app/v1/web";
import { useState } from "react";
import type { Session } from "./contract.ts";

/** The session's search index rebuild (`Search.rebuilds`): running, failed with why, or none. */
export type Reindex = { readonly phase: "running" } | { readonly phase: "failed"; readonly error: string } | undefined;

export function SessionSheet({
	session,
	onClose,
	onRename,
	onPin,
	onArchive,
	onShare,
	onCwd,
	reindex,
	onReindex,
}: {
	session: Session;
	onClose: () => void;
	onRename: (title: string) => void;
	onPin: () => void;
	onArchive: () => void;
	onShare: () => void;
	onCwd: () => void;
	reindex: Reindex;
	/** Re-indexes the session's history for search (long work: the row shows it running); absent without search. */
	onReindex: (() => void) | undefined;
}) {
	const [title, setTitle] = useState(session.title);
	const changed = title.trim() !== "" && title.trim() !== session.title;
	return (
		<Sheet title="Session" onClose={onClose}>
			<form
				className="inline-form"
				onSubmit={(event) => {
					event.preventDefault();
					if (changed) onRename(title.trim());
					onClose();
				}}
			>
				<input
					className="input"
					aria-label="Title"
					value={title}
					onChange={(event) => setTitle(event.target.value)}
				/>
				{changed && (
					<button type="submit" className="text-action">
						Save
					</button>
				)}
			</form>
			<div className="list">
				<button type="button" className="row-button" onClick={onShare}>
					<span>Share</span>
					<ChevronIcon />
				</button>
				<button type="button" className="row-button" onClick={onCwd}>
					<span>Working directory</span>
					<small className="row-value mono">{locationLabel(session.env, session.cwd)}</small>
					<ChevronIcon />
				</button>
				<button type="button" className="row-button" onClick={onPin}>
					<span>{session.pinned ? "Unpin" : "Pin to top"}</span>
				</button>
				{onReindex && (
					<button type="button" className="row-button" disabled={reindex?.phase === "running"} onClick={onReindex}>
						<span>{reindex?.phase === "running" ? "Rebuilding search index…" : "Rebuild search index"}</span>
						{reindex?.phase === "failed" && <small className="row-value error">{reindex.error}</small>}
					</button>
				)}
				<button type="button" className="row-button danger" onClick={onArchive}>
					<span>Archive</span>
				</button>
			</div>
		</Sheet>
	);
}
