// Projects in the TUI (`projects.json`, the projects plugin): whether each place of a project is reachable, as the
// session selector's project rows show it, and resolving a place for `/move <env>`. A place is resolved with
// `Envs.listDirectory`, which expands `~` on its machine and fails when that machine is unreachable.

import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import type { TuiContext } from "@p2/app/v1/tui";
import type { ProjectPlace } from "../projects/contract.ts";
import { ownerEnvs } from "./tui-location.ts";

/**
 * A probed place: still checking; reachable at its absolute path; its machine answered but has no such directory
 * (`missing`); or its machine could not be reached or is not configured (`unreachable`). `reason` is short, for people.
 */
export type PlaceState =
	| { kind: "checking" }
	| { kind: "reachable"; path: string }
	| { kind: "missing"; reason: string }
	| { kind: "unreachable"; reason: string };

/** How a probed place reads in a project row: `?` is a machine that answered without the folder. */
export const PLACE_MARK: Record<
	PlaceState["kind"],
	{ text: string; color: "muted" | "success" | "warning" | "error" }
> = {
	checking: { text: "…", color: "muted" },
	reachable: { text: "✓", color: "success" },
	missing: { text: "?", color: "warning" },
	unreachable: { text: "✗", color: "error" },
};

/** Why a place cannot be used (`mac: no folder ~/x`); undefined while it is checking or when it is reachable. */
export const placeProblem = (label: string, state: PlaceState): string | undefined =>
	state.kind === "missing" || state.kind === "unreachable" ? `${label}: ${state.reason}` : undefined;

/** The absolute path of `place` on its machine; throws when the machine or the directory cannot be reached. */
export async function resolvePlace(ctx: TuiContext, place: ProjectPlace): Promise<string> {
	const envs = await ownerEnvs(ctx);
	if (envs.variant !== "owner") throw new Error("Environments are owner-only");
	const listing = await envs.listDirectory(
		{ path: place.path, ...(place.env ? { env: place.env } : {}) },
		BACKGROUND_CONTEXT,
	);
	return listing.path;
}

/**
 * Why `Envs.listDirectory` failed for `place`, from its message (the only part that crosses the link): Node's and the
 * pi-env daemon's `ENOENT`/`ENOTDIR` (`scandir`/`opendir`) and the SSH manager's "Working directory is not a
 * directory" mean the machine answered without the folder; "Environment "x" is not configured" names no environment;
 * anything else (refused, timed out, no daemon, …) is unreachable with its own message.
 */
export function placeFailure(place: ProjectPlace, error: unknown): PlaceState {
	const message = error instanceof Error ? error.message : String(error);
	if (/\b(ENOENT|ENOTDIR)\b|^Working directory is not a directory$/.test(message))
		return { kind: "missing", reason: `no folder ${place.path}` };
	if (/^Environment ".*" is not configured$/.test(message))
		return { kind: "unreachable", reason: "no such environment" };
	return { kind: "unreachable", reason: message };
}

const placeKey = (place: ProjectPlace): string => `${place.env ?? ""}\0${place.path}`;

/** The places' probes: one per place, started in the background, replaced as a whole by `restart`. */
export class PlaceProbes {
	readonly #probes = new Map<string, { state: PlaceState; result: Promise<PlaceState> }>();
	readonly #ctx: TuiContext;
	readonly #changed: () => void;
	constructor(ctx: TuiContext, changed: () => void) {
		this.#ctx = ctx;
		this.#changed = changed;
	}

	/** Forgets every result and probes `places` again (the selector was shown). */
	restart(places: readonly ProjectPlace[]): void {
		this.#probes.clear();
		this.probe(places);
	}

	/** Probes the places not probed yet (projects.json changed). */
	probe(places: readonly ProjectPlace[]): void {
		for (const place of places) this.result(place);
	}

	/** What is known of `place`: checking until it is probed. */
	state(place: ProjectPlace): PlaceState {
		return this.#probes.get(placeKey(place))?.state ?? { kind: "checking" };
	}

	/** The outcome of `place`'s probe, started now unless it runs or ran. */
	result(place: ProjectPlace): Promise<PlaceState> {
		const key = placeKey(place);
		const existing = this.#probes.get(key);
		if (existing) return existing.result;
		const probe: { state: PlaceState; result: Promise<PlaceState> } = {
			state: { kind: "checking" },
			result: resolvePlace(this.#ctx, place).then(
				(path): PlaceState => ({ kind: "reachable", path }),
				(error: unknown) => placeFailure(place, error),
			),
		};
		this.#probes.set(key, probe);
		void probe.result.then((state) => {
			probe.state = state;
			// A restart replaced this probe: its outcome is no longer shown.
			if (this.#probes.get(key) === probe) this.#changed();
		});
		return probe.result;
	}
}
