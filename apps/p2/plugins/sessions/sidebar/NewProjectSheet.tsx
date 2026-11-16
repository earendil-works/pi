// New project, from the Projects rollup's options: a folder picker (its own layer, `PROJECT_FOLDER`), then this sheet
// names the project at the chosen place (`NEW_PROJECT`, its locator the place) and adds it to projects.json.
import { compile, nul, obj, str, union } from "@earendil-works/pi-schema";
import { type Layer, Sheet, shortPath } from "@p2/app/v1/web";
import { useEffect, useRef, useState } from "react";
import type { ProjectPlace } from "../../projects/contract.ts";

/** The layer of the folder picker that New project opens (not the chat's `cwd`: that one moves the open session). */
export const PROJECT_FOLDER = "project-folder";

/** The layer of the sheet naming the new project. */
export const NEW_PROJECT = "new-project";

/** The sheet's layer for the folder `place`. */
export const newProjectLayer = (place: ProjectPlace): Layer => ({
	kind: "sheet",
	name: NEW_PROJECT,
	locator: JSON.stringify(place),
});

const isPlace = compile(obj({ env: union([str(), nul()]), path: str() })).check;

/** The place a locator names; undefined for anything else (locators come from the URL). */
export function placeOf(locator: string | undefined): ProjectPlace | undefined {
	try {
		const value: unknown = JSON.parse(locator ?? "");
		return isPlace(value) ? { env: value.env, path: value.path } : undefined;
	} catch {
		return undefined;
	}
}

/** Names a project at `place`; the folder's name is the first guess. Closes once `onCreate` succeeded. */
export function NewProjectSheet({
	place,
	taken,
	onCreate,
	onClose,
}: {
	place: ProjectPlace;
	/** The names projects.json has. */
	taken: readonly string[];
	onCreate: (name: string) => Promise<void>;
	onClose: () => void;
}) {
	const [draft, setDraft] = useState(place.path.split(/[\\/]/).filter(Boolean).at(-1) ?? "");
	const [error, setError] = useState<string>();
	const [creating, setCreating] = useState(false);
	// The field is what the sheet is for: focused, its text selected, so typing replaces the guess.
	const field = useRef<HTMLInputElement>(null);
	useEffect(() => {
		field.current?.focus();
		field.current?.select();
	}, []);
	const name = draft.trim();
	const exists = taken.includes(name);
	const create = () => {
		setCreating(true);
		setError(undefined);
		onCreate(name).then(onClose, (caught: unknown) => {
			setError(caught instanceof Error ? caught.message : String(caught));
			setCreating(false);
		});
	};
	return (
		<Sheet title="New project" onClose={onClose}>
			<form
				className="stack"
				onSubmit={(event) => {
					event.preventDefault();
					if (name && !exists && !creating) create();
				}}
			>
				<label className="field">
					<span className="label">Name</span>
					<input
						ref={field}
						className="input"
						value={draft}
						maxLength={64}
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						onChange={(event) => setDraft(event.target.value)}
					/>
				</label>
				<p className="muted small">
					In {place.env ? `${place.env}:${place.path}` : shortPath(place.path)}. Added to projects.json; more
					places go there by hand.
				</p>
				{exists && <p className="small rollup-error">A project "{name}" exists already.</p>}
				{error && <p className="small rollup-error">{error}</p>}
				<div className="inline-form">
					<button type="submit" className="button primary" disabled={!name || exists || creating}>
						{creating ? "Creating…" : "Create"}
					</button>
				</div>
			</form>
		</Sheet>
	);
}
