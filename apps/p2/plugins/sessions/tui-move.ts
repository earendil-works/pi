// `/move` in the TUI: the viewed session moves to another place of its project (`projects.json`, the projects plugin).
// `/move <env>` names the machine; `/move` alone opens a picker of the project's places, probed as it opens. The
// session's project is the one it belongs to (`Projects.sessions`), never derived from its directory; the move is
// `/cd`'s (the selector's `relocate`: confirmed, then `Sessions.relocate`) and keeps the subfolder below the project's
// place.

import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { TuiContext } from "@p2/app/v1/tui";
import { ListOverlay, lineText } from "@p2/app/v1/tui";
import { below, type Project, type ProjectPlace, placeLabel, placeOn } from "../projects/contract.ts";
import type { Session } from "./contract.ts";
import { joinPath, type Location, locationLabel } from "./tui-location.ts";
import { PLACE_MARK, PlaceProbes, resolvePlace } from "./tui-projects.ts";

/** What `/move` reads from the session selector: its sessions, the projects and their members. */
export type MoveSource = {
	session(id: string | undefined): Session | undefined;
	readonly projects: readonly Project[];
	readonly localLabel: string;
	projectOf(id: string): string | undefined;
};

/** The selector's move of a session (`/cd`'s: confirmed when the machine changes, then `Sessions.relocate`). */
export type Relocate = (session: Session, location: Location) => Promise<void>;

/** `/move [env]`: moves the viewed session to its project's place on `env`, or opens the picker without one. */
export async function runMove(ctx: TuiContext, source: MoveSource, argument: string, relocate: Relocate) {
	const session = source.session(ctx.identity.session);
	if (!session) return;
	const found = storedProject(source, session);
	if ("error" in found) ctx.notify(found.error, "error");
	else if (argument) await moveTo(ctx, source, relocate, session, found.project, argument);
	else openPicker(ctx, source, relocate, session, found.project);
}

/** `/move`'s completions: the places of the viewed session's project on other machines. */
export function completeMove(ctx: TuiContext, source: MoveSource, prefix: string): AutocompleteItem[] | null {
	const session = source.session(ctx.identity.session);
	const found = session ? storedProject(source, session) : undefined;
	if (!session || !found || "error" in found) return null;
	const items = found.project.places
		.filter((place) => place.env !== (session.env ?? null))
		.map((place) => ({
			value: placeLabel(place, source.localLabel),
			label: placeLabel(place, source.localLabel),
			description: `${found.project.name}: ${place.path}`,
		}))
		.filter((item) => item.value.startsWith(prefix));
	return items.length ? items : null;
}

/** The project `session` belongs to while projects.json still has it; else why `/move` cannot move it. */
function storedProject(source: MoveSource, session: Session): { project: Project } | { error: string } {
	const name = source.projectOf(session.id);
	if (name === undefined)
		return { error: "This session belongs to no project: start one from a project's row in /sessions" };
	const project = source.projects.find((each) => each.name === name);
	return project ? { project } : { error: `Project ${lineText(name)} is no longer in projects.json` };
}

/**
 * Moves `session` to `project`'s place on the machine `name` names (an environment's name, or this device as `local`
 * or its label). Below the project's place on its current machine (read from the paths alone: that machine may be
 * unreachable), it keeps its subdirectory when the target has it, else goes to the target place's root; only the
 * target is resolved.
 */
async function moveTo(
	ctx: TuiContext,
	source: MoveSource,
	relocate: Relocate,
	session: Session,
	project: Project,
	name: string,
): Promise<void> {
	const place = placeOn(project, name, source.localLabel);
	if (!place) {
		ctx.notify(`Project ${lineText(project.name)} has no place on ${lineText(name)}`, "error");
		return;
	}
	const label = lineText(placeLabel(place, source.localLabel));
	let path: string;
	try {
		path = await resolvePlace(ctx, place);
	} catch (error) {
		ctx.notify(
			`${label} is unreachable: ${lineText(error instanceof Error ? error.message : String(error))}`,
			"error",
		);
		return;
	}
	const current = project.places.find((each) => each.env === (session.env ?? null));
	const subpath = current && below(session.cwd, current.path);
	if (subpath) {
		try {
			path = await resolvePlace(ctx, { env: place.env, path: joinPath(path, subpath) });
		} catch {
			ctx.notify(`${lineText(subpath)} does not exist on ${label}; moving to the project's root`, "warning");
		}
	}
	if (place.env === (session.env ?? null) && path === session.cwd) {
		ctx.notify(`The session is already at ${lineText(locationLabel({ env: place.env, path }))}`);
		return;
	}
	await relocate(session, { env: place.env, path });
}

/**
 * The picker: every place of `project` in projects.json's order, the session's own one marked current, the others
 * probed now (`…`, `✓`, `?`, `✗`, with why a place cannot be used). The cursor starts on the first other place that is
 * reachable (it waits on one still checking); Enter on a reachable one moves there (`moveTo`), on the current one only
 * closes, the others cannot be chosen.
 */
function openPicker(ctx: TuiContext, source: MoveSource, relocate: Relocate, session: Session, project: Project): void {
	const here = project.places.find((place) => place.env === (session.env ?? null));
	const others = project.places.filter((place) => place !== here);
	if (!others.length) {
		ctx.notify(`Project ${lineText(project.name)} has no place on another machine`, "error");
		return;
	}
	const label = (place: ProjectPlace) => placeLabel(place, source.localLabel);
	// The cursor follows the first other place not known to be unusable, until it is reachable or the reader moves it.
	let following: string | undefined = label(others[0]!);
	const settle = () => {
		if (following === undefined) return;
		if (list.selection !== following) following = undefined;
		const next = others.find((place) => ["checking", "reachable"].includes(probes.state(place).kind));
		if (following === undefined || !next) return;
		following = probes.state(next).kind === "reachable" ? undefined : label(next);
		list.select(label(next));
	};
	const probes = new PlaceProbes(ctx, () => {
		settle();
		ctx.requestRender();
	});
	let status = "";
	const list = new ListOverlay(ctx, {
		title: `Move within ${lineText(project.name)}`,
		selected: label(others[0]!),
		rows: () =>
			project.places.map((place) => {
				if (place === here)
					return { key: label(place), label: `• ${label(place)}  ${place.path}`, detail: "current" };
				const state = probes.state(place);
				return {
					key: label(place),
					label: `${PLACE_MARK[state.kind].text} ${label(place)}  ${place.path}`,
					detail: state.kind === "missing" || state.kind === "unreachable" ? state.reason : "",
					...(state.kind === "reachable" ? {} : { color: "muted" as const }),
				};
			}),
		onSelect: (row) => {
			const place = project.places.find((each) => label(each) === row.key);
			if (place === here) {
				overlay.close();
				ctx.notify("Already here");
				return;
			}
			if (!place || probes.state(place).kind !== "reachable") {
				status = `${row.key} cannot be chosen: only ✓ places are reachable`;
				return;
			}
			overlay.close();
			void moveTo(ctx, source, relocate, session, project, row.key).catch((error: unknown) => ctx.fail(error));
		},
		footer: () => (status ? [ctx.theme.current.fg("warning", `  ${lineText(status)}`)] : []),
		onClose: () => overlay.close(),
	});
	const overlay = ctx.overlay("move", list, { width: "100%", anchor: "bottom-center" });
	probes.probe(others);
}
