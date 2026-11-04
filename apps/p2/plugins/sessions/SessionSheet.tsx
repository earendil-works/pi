import { ChevronIcon, locationLabel, Sheet } from "@p2/app/v1/web";
import { useState } from "react";
import type { Session } from "./contract.ts";
export function SessionSheet({
	session,
	onClose,
	onRename,
	onPin,
	onArchive,
	onShare,
	onCwd,
}: {
	session: Session;
	onClose: () => void;
	onRename: (title: string) => void;
	onPin: () => void;
	onArchive: () => void;
	onShare: () => void;
	onCwd: () => void;
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
				<button type="button" className="row-button danger" onClick={onArchive}>
					<span>Archive</span>
				</button>
			</div>
		</Sheet>
	);
}
